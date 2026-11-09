/**
 * The page `tokenwise dashboard` serves: a jar that fills with what TokenWise
 * saved you. One job only: let people see that their agents read less. Style
 * and script are inline (under the request's nonce) so the page ships inside
 * the CLI bundle.
 */
import { AGENT_LOGOS, TOKENWISE_LOGO } from './dashboard-logos.ts'
import type { Savings } from './savings.ts'

export interface PageOptions {
  readonly nonce: string
  readonly token: string
  readonly language: 'en' | 'zh'
  readonly week: Savings
  readonly all: Savings
}

/** Logos are placed many times on one page: give each copy's ids a prefix of its own. Style attributes go: the page's policy refuses them. */
const logos = Object.fromEntries(Object.entries(AGENT_LOGOS).map(([id, svg]) => [id,
  svg.replace(/\sstyle="[^"]*"/gu, '').replace(/id="([^"]+)"/gu, `id="${id}-$1"`).replace(/url\(#([^)]+)\)/gu, `url(#${id}-$1)`).replace(/href="#([^"]+)"/gu, `href="#${id}-$1"`)]))
logos.shell = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="16" fill="#1B2B27"/><path d="M18 22l12 10-12 10" fill="none" stroke="#7FD6C4" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 44h13" stroke="#7FD6C4" stroke-width="5" stroke-linecap="round"/></svg>'

const STRINGS = {
  en: { week: 'This week', month: 'Last 30 days', all: 'Since you installed it', saved: 'TokenWise saved you', unit: 'tokens',
    outputs: 'from {n} shortened command outputs', today: 'Today so far', perDay: 'per day', perMonth: 'per month', agents: 'saved in {n} of your agents',
    agents1: 'saved in your agent', share: 'Copy to share', copied: 'Copied', shareText: 'TokenWise saved me {n} tokens {p}.', local: 'Counted on this computer only. Nothing is uploaded.',
    emptyTitle: 'Nothing saved yet', empty: 'Use your agents as usual. When a test run or a build prints a long output, TokenWise shortens what the model reads, and the tokens it saved drop in here.',
    pWeek: 'this week', pMonth: 'in the last 30 days', pAll: 'so far', off: 'Could not reach TokenWise. Is tokenwise dashboard still running?' },
  zh: { week: '这周', month: '最近 30 天', all: '装上以来', saved: 'TokenWise 已为你省下', unit: 'token',
    outputs: '来自 {n} 次被缩短的命令输出', today: '今天已省', perDay: '每天省下的', perMonth: '每月省下的', agents: '在你的 {n} 个 agent 里一起省',
    agents1: '在你的 agent 里省下', share: '复制分享文字', copied: '已复制', shareText: 'TokenWise {p}帮我省了 {n} 个 token。', local: '只在你的电脑上统计，不会上传。',
    emptyTitle: '还没有省下 token', empty: '照常使用你的 agent。跑测试、构建这类命令输出很长时，TokenWise 会把模型要读的部分缩短，省下的就会落进这里。',
    pWeek: '这周', pMonth: '最近 30 天', pAll: '一共', off: '连不上 TokenWise。tokenwise dashboard 还在运行吗？' },
}

const CSS = `
:root{--bg:#F4F7F5;--ink:#15241F;--soft:#61736D;--mute:#9AA9A4;--glass:#D3E0DB;--teal:#0F7A6A;--c4:#8ED7C7;--c2:#169985;
--hi1:#3FA592;--c1:#0F7A6A;--lo1:#0A5A4E;--hi2:#4FC2AD;--cc2:#169985;--lo2:#0F7563;--hi3:#8EE0CF;--c3:#3DB8A2;--lo3:#2A9884;--hi4:#D4F4EC;--cc4:#8ED7C7;--lo4:#5FB9A6;--lid1:#E3ECE8;--lid2:#C9D8D2;--shine:.75}
@media (prefers-color-scheme:dark){:root{--bg:#0E1513;--ink:#E7F0ED;--soft:#9BAEA8;--mute:#5F726C;--glass:#2B3A36;--teal:#3DB8A2;--c4:#9BE3D4;--c2:#2FB49D;
--hi1:#47BFA9;--c1:#1D9B86;--lo1:#11685A;--hi2:#62D3BD;--cc2:#2FB49D;--lo2:#1B8572;--hi3:#93E6D5;--c3:#58CDB7;--lo3:#36A08B;--hi4:#D5F6EE;--cc4:#9BE3D4;--lo4:#6BBDAB;--lid1:#33433F;--lid2:#25332F;--shine:.12}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,"PingFang SC","Helvetica Neue","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer}button:focus-visible{outline:2px solid var(--teal);outline-offset:3px}
.wrap{min-height:100%;max-width:980px;margin:0 auto;padding:28px 32px 36px;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px}header>svg{width:24px;height:24px}header b{font-weight:600;margin-right:auto}
.seg{display:flex;gap:2px;background:color-mix(in srgb,var(--glass) 60%,transparent);border-radius:20px;padding:3px}.seg button{border:0;background:none;color:var(--soft);font-size:13px;padding:5px 13px;border-radius:16px}
.seg button[aria-pressed=true]{background:var(--bg);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.lang{border:0;background:none;color:var(--mute);font-size:13px;margin-left:6px;padding:5px 8px}
main{flex:1;display:grid;grid-template-columns:340px 1fr;gap:72px;align-items:center;padding:36px 0}
.jar{width:300px;height:400px;justify-self:end}.jar svg{width:100%;height:100%;overflow:visible}
.glass{fill:color-mix(in srgb,var(--glass) 16%,transparent);stroke:var(--glass);stroke-width:3}.gl{fill:none;stroke:#fff;stroke-opacity:var(--shine);stroke-width:5;stroke-linecap:round}
.coin{stroke:rgba(0,0,0,.08);stroke-width:1}
.k{color:var(--soft);font-size:17px}
.big{font:600 64px/1.05 "Avenir Next","SF Pro Display",-apple-system,"Segoe UI",sans-serif;letter-spacing:-1.5px;margin:6px 0 4px;font-variant-numeric:tabular-nums}
.big small{font:500 20px -apple-system,"PingFang SC",sans-serif;letter-spacing:0;color:var(--soft);margin-left:8px}
.plain{font-size:16.5px;margin:0 0 28px;max-width:26em}
.today{display:inline-flex;align-items:center;gap:10px;font-size:14px;color:var(--soft);padding:8px 14px 8px 12px;border-radius:24px;background:color-mix(in srgb,var(--glass) 50%,transparent)}
.today b{color:var(--ink);font-variant-numeric:tabular-nums;font-weight:600}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--c2);animation:pulse 2.4s infinite}@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--c2) 60%,transparent)}70%,100%{box-shadow:0 0 0 8px transparent}}
.spark{display:flex;align-items:flex-end;gap:3px;height:44px;margin:32px 0 8px}.spark i{flex:none;width:10px;min-height:3px;border-radius:3px;background:var(--c4);transition:height .5s}.spark i.now{background:var(--c2)}
.spark.thin i{width:5px;border-radius:2px}
.spark-l{font-size:12.5px;color:var(--mute)}
.who{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:28px;font-size:14px;color:var(--soft)}.who svg{width:28px;height:28px;border-radius:8px}.who span{margin-left:8px}
.empty h2{font-size:26px;margin:0 0 10px}.empty p{color:var(--soft);max-width:28em;margin:0}
footer{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:12.5px;color:var(--mute)}
.share{border:0;background:var(--ink);color:var(--bg);font-size:14px;font-weight:500;padding:10px 20px;border-radius:24px}
.off{color:#B87A00}
@media (max-width:820px){main{grid-template-columns:1fr;gap:16px;text-align:center}.jar{justify-self:center;width:220px;height:293px}.plain,.empty p{margin-inline:auto}.spark,.who{justify-content:center}.big{font-size:46px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`

const JAR = `<svg viewBox="0 0 300 400" aria-hidden="true"><defs>${[1, 2, 3, 4].map(i =>
  `<radialGradient id="g${i}" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="var(--hi${i})"/><stop offset=".55" stop-color="var(--${i === 2 ? 'cc2' : i === 4 ? 'cc4' : 'c' + i})"/><stop offset="1" stop-color="var(--lo${i})"/></radialGradient>`).join('')}
<radialGradient id="shadow"><stop offset="0" stop-color="var(--ink)" stop-opacity=".16"/><stop offset="1" stop-color="var(--ink)" stop-opacity="0"/></radialGradient>
<linearGradient id="lid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--lid1)"/><stop offset="1" stop-color="var(--lid2)"/></linearGradient>
<clipPath id="inside"><path d="M104 34v18c0 14-52 24-52 58v212c0 24 16 40 40 40h116c24 0 40-16 40-40V110c0-34-52-44-52-58V34z"/></clipPath></defs>
<ellipse cx="150" cy="384" rx="118" ry="10" fill="url(#shadow)"/><rect x="88" y="6" width="124" height="22" rx="7" fill="url(#lid)"/>
<g id="coins" clip-path="url(#inside)"></g><path class="glass" d="M100 30v22c0 10-52 22-52 58v214c0 26 18 44 44 44h116c26 0 44-18 44-44V110c0-36-52-48-52-58V30"/>
<path class="gl" d="M66 132c-4 10-5 18-5 30v96"/><path class="gl" d="M66 278v14"/></svg>`

/** Client: draws the jar, counts up, polls every few seconds and drops a coin when today grows. */
const SCRIPT = `
const B=JSON.parse(document.getElementById('boot').textContent),S=B.strings,L=B.logos;let lang=B.language,period='week',cur=B.week,all=B.all,placed=0,cap=0;
const $=s=>document.querySelector(s),still=matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt=n=>Math.round(n).toLocaleString('en-US'),t=(k,v={})=>S[lang][k].replace(/\\{(\\w+)\\}/g,(_,x)=>v[x]);
const COLS=10,R=10.5,X0=62,Y0=350;
function slot(i){const row=Math.floor(i/COLS),col=i%COLS;return{x:X0+col*18.5+(row%2?9.25:0)+Math.sin(i*7.3)*1.5,y:Y0-row*16.5+Math.cos(i*3.1)*1.5,tone:1+(i*5+row)%4}}
function coin(i,delay,fall){const s=slot(i),c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx',s.x);c.setAttribute('cy',s.y);c.setAttribute('r',R);
 c.setAttribute('class','coin');c.setAttribute('fill','url(#g'+s.tone+')');$('#coins').appendChild(c);
 if(!still&&fall)c.animate([{transform:'translateY('+(20-s.y)+'px)',opacity:0},{opacity:1,offset:.2},{transform:'translateY(0)'}],{duration:fall,delay,easing:'cubic-bezier(.3,1.25,.5,1)',fill:'backwards'})}
// How full the jar is: this period against everything saved so far (the square root keeps a quiet week visible), and
// less for small amounts, so a first thousand tokens is a few coins, not a full jar.
function fill(){$('#coins').replaceChildren();const size=Math.min(1,Math.max(.12,Math.log10(cur.tokens/500+1)/3));
 const f=cur.tokens?Math.max(.07,.9*Math.sqrt(cur.tokens/Math.max(all.tokens,cur.tokens))*size):0;cap=COLS*14;placed=Math.round(f*14)*COLS;
 for(let i=0;i<placed;i++)coin(i,i*6,700)}
function count(el,from,to){if(still){el.textContent=fmt(to);return}const t0=performance.now(),d=1200;(function step(n){const k=Math.min(1,(n-t0)/d),e=1-Math.pow(1-k,3);el.textContent=fmt(from+(to-from)*e);if(k<1)requestAnimationFrame(step)})(t0)}
function label(b){const d=new Date(b.start);if(period==='all')return lang==='zh'?(d.getMonth()+1)+'月':d.toLocaleString('en',{month:'short'});return period==='week'?(lang==='zh'?'日一二三四五六'[d.getDay()]:'SMTWTFS'[d.getDay()]):''}
function render(fresh){document.documentElement.lang=lang==='zh'?'zh':'en';
 document.querySelectorAll('[data-p]').forEach(b=>{b.textContent=t(b.dataset.p);b.setAttribute('aria-pressed',b.dataset.p===period)});$('#lang').textContent=lang==='zh'?'EN':'中文';
 $('#share').textContent=t('share');$('#local').textContent=t('local');
 const has=cur.tokens>0;$('#filled').hidden=!has;$('#empty').hidden=has;
 $('#emptyTitle').textContent=t('emptyTitle');$('#emptyText').textContent=t('empty');
 if(fresh)fill();if(!has)return;
 $('#k').textContent=t(period)+(lang==='zh'?'，':', ')+t('saved');$('#unit').textContent=t('unit');
 if(fresh)count($('#num'),0,cur.tokens);else $('#num').textContent=fmt(cur.tokens);
 $('#plain').textContent=t('outputs',{n:fmt(cur.outputs)});$('#todayL').textContent=t('today');$('#today').textContent=fmt(cur.today);
 const max=Math.max(1,...cur.buckets.map(b=>b.tokens)),sp=$('#spark');sp.className='spark'+(cur.buckets.length>12?' thin':'');sp.replaceChildren();
 cur.buckets.forEach((b,i)=>{const e=document.createElement('i');e.style.height=(3+b.tokens/max*41).toFixed(0)+'px';e.title=(label(b)?label(b)+' ':'')+fmt(b.tokens);if(i===cur.buckets.length-1)e.className='now';sp.appendChild(e)});
 $('#sparkL').textContent=period==='all'?t('perMonth'):t('perDay');
 const w=$('#who');w.replaceChildren();cur.agents.forEach(a=>{const s=document.createElement('span');s.innerHTML=L[a]||L.shell;const g=s.firstChild;const ti=document.createElementNS('http://www.w3.org/2000/svg','title');ti.textContent=B.names[a]||a;g.prepend(ti);w.appendChild(g)});
 const n=document.createElement('span');n.textContent=cur.agents.length>1?t('agents',{n:cur.agents.length}):t('agents1');w.appendChild(n)}
async function load(p){const r=await fetch('/api/savings?period='+p+'&t='+B.token,{cache:'no-store'});if(!r.ok)throw new Error(r.status);return r.json()}
document.querySelectorAll('[data-p]').forEach(b=>b.onclick=async()=>{period=b.dataset.p;try{const d=await load(period);cur=d.savings;all=d.all;render(true)}catch{$('#local').textContent=t('off')}});
$('#lang').onclick=()=>{lang=lang==='zh'?'en':'zh';render(false)};
$('#share').onclick=async()=>{const p={week:'pWeek',month:'pMonth',all:'pAll'}[period];try{await navigator.clipboard.writeText(t('shareText',{n:fmt(cur.tokens),p:t(p)}));$('#share').textContent=t('copied');setTimeout(()=>$('#share').textContent=t('share'),1600)}catch{}};
setInterval(async()=>{try{const d=await load(period);const before=cur;cur=d.savings;all=d.all;
 if(cur.tokens>before.tokens&&before.tokens>0){count($('#num'),before.tokens,cur.tokens);if(placed<cap)coin(placed++,0,900)}
 render(before.tokens===0&&cur.tokens>0);$('#local').textContent=t('local')}catch{$('#local').textContent=t('off');$('#local').className='off'}},4000);
render(true);`

const json = (value: unknown) => JSON.stringify(value).replace(/</gu, '\\u003c')

export function dashboardPage(options: PageOptions): string {
  const boot = { token: options.token, language: options.language, week: options.week, all: options.all, strings: STRINGS, logos,
    names: { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot CLI', hermes: 'Hermes', opencode: 'OpenCode', codebuddy: 'CodeBuddy', grok: 'Grok Build', dsh: 'DeepSeek Harness', pi: 'pi', shell: 'Terminal' } }
  const s = STRINGS[options.language]
  return `<!doctype html><html lang="${options.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TokenWise</title>
<style nonce="${options.nonce}">${CSS}</style></head><body><div class="wrap">
<header>${TOKENWISE_LOGO.replace(/\sstyle="[^"]*"/gu, '')}<b>TokenWise</b><div class="seg"><button data-p="week" aria-pressed="true">${s.week}</button><button data-p="month" aria-pressed="false">${s.month}</button><button data-p="all" aria-pressed="false">${s.all}</button></div><button class="lang" id="lang"></button></header>
<main><div class="jar">${JAR}</div>
<section id="filled"><div class="k" id="k"></div><div class="big"><span id="num">0</span><small id="unit"></small></div><p class="plain" id="plain"></p>
<span class="today"><span class="pulse"></span><span id="todayL"></span><b id="today">0</b></span>
<div class="spark" id="spark"></div><div class="spark-l" id="sparkL"></div><div class="who" id="who"></div></section>
<section class="empty" id="empty" hidden><h2 id="emptyTitle"></h2><p id="emptyText"></p></section></main>
<footer><span id="local"></span><button class="share" id="share"></button></footer></div>
<script type="application/json" id="boot">${json(boot)}</script><script nonce="${options.nonce}">${SCRIPT}</script></body></html>`
}
