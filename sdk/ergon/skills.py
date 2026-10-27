"""Agent Skills: folders containing a SKILL.md with YAML-ish frontmatter
(name / description). Discovery loads only the metadata; the full skill body
is loaded progressively — the agent pulls it in with the load_skill tool
only when it decides the skill is relevant.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List

from .tools import Tool, tool

_FRONT = re.compile(r"^---\s*\n(.*?)\n---", re.S)


class SkillLibrary:
    def __init__(self, skills_dir: str):
        self.dir = Path(skills_dir)
        self.skills: Dict[str, Dict[str, str]] = {}
        self._discover()

    def _discover(self) -> None:
        if not self.dir.exists():
            return
        for md in sorted(self.dir.glob("**/SKILL.md")):
            meta = {"name": md.parent.name, "description": ""}
            m = _FRONT.match(md.read_text(errors="replace"))
            if m:
                for line in m.group(1).splitlines():
                    if ":" in line:
                        k, v = line.split(":", 1)
                        if k.strip() in ("name", "description"):
                            meta[k.strip()] = v.strip()
            self.skills[meta["name"]] = {**meta, "path": str(md)}

    def metadata_prompt(self) -> str:
        if not self.skills:
            return ""
        lines = [f"- {s['name']}: {s['description']}" for s in self.skills.values()]
        return (
            "You have access to these skills (call load_skill to read one in "
            "full before relying on it):\n" + "\n".join(lines)
        )

    def load_tool(self) -> Tool:
        lib = self

        @tool("Load the full instructions of a named skill.", safe=True)
        def load_skill(skill_name: str) -> str:
            s = lib.skills.get(skill_name)
            if not s:
                return f"unknown skill '{skill_name}'. Available: {', '.join(lib.skills)}"
            return Path(s["path"]).read_text(errors="replace")[:60_000]

        return load_skill
