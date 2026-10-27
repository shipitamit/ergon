/* Build a static docs site from the repo's READMEs — zero build deps.

   Reads the Markdown docs, embeds them in a single self-contained page, and
   renders them client-side with marked (pinned CDN) and a left nav built from
   the doc list and each doc's H2 headings. The Markdown is embedded (not
   fetched), so the page works from file:// too; only the renderer loads from a
   CDN, with a raw-text fallback if it doesn't.

     node scripts/build-docs.mjs      # writes docs/index.html

   Host docs/ on any static server (GitHub Pages, S3, nginx).
*/
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// doc order defines the nav order
const DOCS = [
  { id: "overview", title: "Overview", file: "README.md" },
  { id: "sdk", title: "SDK", file: "sdk/README.md" },
  { id: "studio", title: "Studio", file: "studio/README.md" },
  { id: "sdk-tests", title: "SDK tests", file: "sdk/tests/README.md" },
];

const docs = DOCS.map((d) => {
  let md = readFileSync(join(ROOT, d.file), "utf8");
  // neutralize any literal </script> so the embedded string can't close our tag
  md = md.replace(/<\/script>/gi, "<\\/script>");
  return { ...d, md };
});

const DATA = JSON.stringify(docs);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Ergon Documentation</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
<style>
  :root {
    --bg:#f4f6f4; --surface:#fff; --surface-2:#eceeec; --fg:#15180f; --fg-muted:#576055;
    --fg-faint:#8a928a; --border:#d7ddd6; --accent:#137a44; --accent-2:#1f9e5a; --sidebar:#eef1ee;
    --code-bg:#f0f2ef; --code-fg:#1f2a20;
    --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){ :root{
    --bg:#0c0f0c; --surface:#12160f; --surface-2:#171c15; --fg:#e9ede7; --fg-muted:#9aa399;
    --fg-faint:#6b746b; --border:#272d26; --accent:#8ce07a; --accent-2:#5fd48b; --sidebar:#101409;
    --code-bg:#13180f; --code-fg:#cbd5c4; color-scheme:dark;
  }}
  *{box-sizing:border-box;}
  html,body{margin:0;}
  body{background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased;}
  a{color:var(--accent);text-decoration:none;}
  a:hover{text-decoration:underline;}
  .layout{display:flex;min-height:100vh;}
  nav.side{width:250px;flex-shrink:0;background:var(--sidebar);border-right:1px solid var(--border);
    position:sticky;top:0;height:100vh;overflow-y:auto;padding:22px 0;}
  nav.side .brand{font-weight:800;font-size:17px;letter-spacing:-.01em;padding:0 20px 4px;}
  nav.side .tag{font-size:11px;color:var(--fg-faint);padding:0 20px 16px;font-family:var(--mono);}
  nav.side .doc{display:block;padding:7px 20px;font-weight:600;font-size:13.5px;color:var(--fg);cursor:pointer;border:none;background:none;text-align:left;width:100%;}
  nav.side .doc.active{color:var(--accent);box-shadow:inset 3px 0 0 var(--accent);background:var(--surface-2);}
  nav.side .sub{display:block;padding:4px 20px 4px 34px;font-size:12px;color:var(--fg-muted);cursor:pointer;border:none;background:none;text-align:left;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  nav.side .sub:hover{color:var(--accent);}
  main{flex:1;min-width:0;display:flex;justify-content:center;}
  .content{max-width:820px;width:100%;padding:40px max(20px,env(safe-area-inset-right,0px)) 80px max(20px,env(safe-area-inset-left,0px));}
  .content h1{font-size:33px;font-weight:800;letter-spacing:-.02em;margin:.2em 0 .5em;line-height:1.1;}
  .content h2{font-size:23px;font-weight:700;margin:1.8em 0 .5em;padding-top:.3em;border-top:1px solid var(--border);scroll-margin-top:16px;}
  .content h3{font-size:17px;font-weight:700;margin:1.4em 0 .4em;}
  .content p,.content li{font-size:14.5px;}
  .content code{font-family:var(--mono);font-size:.86em;background:var(--code-bg);color:var(--code-fg);padding:1.5px 5px;border-radius:4px;}
  .content pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow-x:auto;}
  .content pre code{background:none;padding:0;font-size:12.5px;line-height:1.5;}
  .content table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;margin:1em 0;font-size:13px;}
  .content th,.content td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top;}
  .content th{background:var(--surface-2);font-weight:700;}
  .content blockquote{border-left:3px solid var(--accent-2);margin:1em 0;padding:.2em 0 .2em 14px;color:var(--fg-muted);}
  .content hr{border:none;border-top:1px solid var(--border);margin:2em 0;}
  .content img{max-width:100%;}
  .menu-btn{display:none;}
  @media (max-width:800px){
    .layout{flex-direction:column;}
    nav.side{position:relative;width:100%;height:auto;max-height:none;border-right:none;border-bottom:1px solid var(--border);}
    nav.side .subs{display:none;}
  }
</style>
</head>
<body>
<div class="layout">
  <nav class="side" id="side"></nav>
  <main><div class="content" id="content"></div></main>
</div>
<script id="docs-data" type="application/json">${DATA}</script>
<script>
(function(){
  var DOCS = JSON.parse(document.getElementById("docs-data").textContent);
  var side = document.getElementById("side"), content = document.getElementById("content");
  function slug(s){ return s.toLowerCase().replace(/[^\\w]+/g,"-").replace(/^-+|-+$/g,""); }
  function render(md){
    if (window.marked) return window.marked.parse(md);
    var pre = document.createElement("pre"); pre.textContent = md; return pre.outerHTML;  // fallback
  }
  function build(){
    side.innerHTML = '<div class="brand">Ergon</div><div class="tag">documentation</div>';
    DOCS.forEach(function(d){
      var b = document.createElement("button"); b.className = "doc"; b.textContent = d.title;
      b.onclick = function(){ location.hash = d.id; };
      side.appendChild(b); d._btn = b;
      var subs = document.createElement("div"); subs.className = "subs"; d._subs = subs; side.appendChild(subs);
    });
  }
  function show(id){
    var d = DOCS.find(function(x){ return x.id === id; }) || DOCS[0];
    content.innerHTML = render(d.md);
    // id + anchor every h2/h3, and (re)build this doc's sub-nav from h2s
    DOCS.forEach(function(x){ x._btn.classList.toggle("active", x === d); x._subs.innerHTML = ""; });
    content.querySelectorAll("h2,h3").forEach(function(h){
      if (!h.id) h.id = slug(h.textContent);
      if (h.tagName === "H2"){
        var s = document.createElement("button"); s.className = "sub"; s.textContent = h.textContent;
        s.onclick = function(){ h.scrollIntoView({behavior:"smooth"}); };
        d._subs.appendChild(s);
      }
    });
    content.scrollIntoView({block:"start"}); window.scrollTo(0,0);
  }
  function route(){ show((location.hash || "").replace(/^#/,"") || DOCS[0].id); }
  build();
  window.addEventListener("hashchange", route);
  if (window.marked && window.marked.setOptions) window.marked.setOptions({ gfm:true });
  route();
})();
</script>
</body>
</html>
`;

mkdirSync(join(ROOT, "docs"), { recursive: true });
writeFileSync(join(ROOT, "docs", "index.html"), html);
console.log("built docs/index.html from", docs.length, "docs:", docs.map((d) => d.title).join(", "));
