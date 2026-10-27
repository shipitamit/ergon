"""Flow orchestration between top-level agents.

These are thin, explicit helpers the Studio's generated code targets for
branching and parallel canvas nodes. They compose Agents; each returns an
AgentResult whose `.usage` aggregates every agent it invoked, so token/cost
totals survive across branches and joins.

    chain(task, a, b, c)                     # a -> b -> c, threading text
    route(task, agent, {"bug": triage,       # agent decides, then dispatch
                        "feature": planner})
    parallel(task, [w1, w2, w3], joiner)     # fan out, then merge
    branch(task, pick, {"short": a,          # deterministic conditional edge
                        "long": b})
    loop(task, worker, until="DONE",         # cyclic edge: repeat until done
         max_rounds=5)
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional, Union

from .agent import Agent, AgentResult
from .usage import Usage

# A flow step is an Agent or any callable (text) -> AgentResult, so flows nest:
# a loop body or a branch target can itself be a chain/route/parallel closure.
Step = Union[Agent, Callable[[str], AgentResult]]


def _run_step(step: "Step", text: str) -> AgentResult:
    if isinstance(step, Agent):
        return step.run(text)
    result = step(text)
    if not isinstance(result, AgentResult):
        raise TypeError("a flow step callable must return an AgentResult")
    return result


def chain(task: str, *agents: Agent) -> AgentResult:
    """Run agents in sequence, feeding each one's text to the next."""
    if not agents:
        raise ValueError("chain() needs at least one agent")
    result = agents[0].run(task)
    total = Usage(); total.merge(result.usage)
    for a in agents[1:]:
        result = a.run(result.text)
        total.merge(result.usage)
    result.usage = total
    return result


def route(
    task: str,
    router: Agent,
    routes: Dict[str, Agent],
    *,
    default: Optional[Agent] = None,
    key: Optional[Callable[[AgentResult], str]] = None,
) -> AgentResult:
    """Ask `router` to classify the task, then dispatch to routes[label].

    By default the router is instructed to reply with exactly one of the route
    labels, and matching is done by substring (case-insensitive). Pass `key`
    to extract the label yourself from the router's AgentResult.
    """
    labels = list(routes)
    if key is None:
        prompt = (f"{task}\n\nClassify this into exactly one of these categories "
                  f"and reply with only that word: {', '.join(labels)}.")
        decision = router.run(prompt)
        picked = decision.text.strip().lower()
        chosen = next((routes[l] for l in labels if l.lower() in picked), default)
    else:
        decision = router.run(task)
        label = key(decision)
        chosen = routes.get(label, default)

    total = Usage(); total.merge(decision.usage)
    if chosen is None:
        decision.usage = total
        decision.stopped_because = "no_route_matched"
        return decision
    result = chosen.run(task)
    total.merge(result.usage)
    result.usage = total
    return result


def parallel(
    task: Union[str, List[str]],
    workers: List[Agent],
    joiner: Optional[Agent] = None,
    *,
    max_workers: Optional[int] = None,
) -> AgentResult:
    """Fan `task` out to workers concurrently, then optionally merge with `joiner`.

    `task` may be one prompt sent to all workers, or a list aligned to workers.
    Without a joiner, the labelled worker outputs are concatenated.
    """
    if not workers:
        raise ValueError("parallel() needs at least one worker")
    tasks = task if isinstance(task, list) else [task] * len(workers)
    if len(tasks) != len(workers):
        raise ValueError("task list length must match workers length")

    with ThreadPoolExecutor(max_workers=max_workers or len(workers)) as pool:
        results = list(pool.map(lambda pair: pair[0].run(pair[1]), zip(workers, tasks)))

    total = Usage()
    for r in results:
        total.merge(r.usage)

    combined = "\n\n".join(f"### {w.name}\n{r.text}" for w, r in zip(workers, results))
    if joiner is None:
        out = AgentResult(combined, [], 0, "joined", total)
        return out

    merged = joiner.run(
        "Combine these parallel results into one coherent answer:\n\n" + combined
    )
    total.merge(merged.usage)
    merged.usage = total
    return merged


def branch(
    task: str,
    predicate: Callable[[str], str],
    branches: Dict[str, "Step"],
    *,
    default: Optional["Step"] = None,
) -> AgentResult:
    """Deterministic conditional edge: `predicate(task)` returns a label, then the
    matching branch runs. Unlike `route`, this needs no extra model call — the
    decision is plain Python, which is what the Studio's conditional edges emit.

    Each branch is an Agent or a callable `(text) -> AgentResult`, so a target can
    itself be another flow. Returns the chosen branch's AgentResult; if no label
    matches and there is no `default`, returns the task unchanged with
    `stopped_because="no_branch:<label>"`.
    """
    label = predicate(task)
    chosen = branches.get(label, default)
    if chosen is None:
        return AgentResult(task, [], 0, f"no_branch:{label}", Usage())
    return _run_step(chosen, task)


def loop(
    task: str,
    body: "Step",
    *,
    until: Optional[Union[str, Callable[[AgentResult], bool]]] = None,
    max_rounds: int = 5,
    feedback: Optional[Callable[[AgentResult], str]] = None,
) -> AgentResult:
    """Cyclic edge: run `body` repeatedly, feeding each round's output into the
    next, until `until` is satisfied or `max_rounds` is reached.

    body     : an Agent or a callable `(text) -> AgentResult`.
    until     : a marker string that must appear in the result text, or a
               callable `(result) -> bool`; None loops the full `max_rounds`.
    max_rounds: hard cap on iterations (>= 1) — the cycle always terminates.
    feedback  : optional `(result) -> str` to build the next input; by default
               the result text is fed back in.

    The returned AgentResult sums every round's usage and reports
    `stopped_because` as `loop_converged` (the condition held) or
    `loop_max_rounds` (the cap was hit).
    """
    if max_rounds < 1:
        raise ValueError("max_rounds must be >= 1")

    def converged(r: AgentResult) -> bool:
        if until is None:
            return False
        if callable(until):
            return bool(until(r))
        return until in (r.text or "")

    total = Usage()
    text_in = task
    result: Optional[AgentResult] = None
    for _ in range(max_rounds):
        result = _run_step(body, text_in)
        total.merge(result.usage)
        if converged(result):
            result.usage = total
            result.stopped_because = "loop_converged"
            return result
        text_in = feedback(result) if feedback else result.text
    # cap reached
    result.usage = total
    result.stopped_because = "loop_max_rounds"
    return result
