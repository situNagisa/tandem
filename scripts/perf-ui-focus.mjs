// 聚焦测：长会话滚动帧 + 流式长任务（过滤掉采样开始前的 longtask，避免污染）。
import { spawn } from 'node:child_process'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'
import WebSocket from 'ws'
const mock = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({data:[{id:'perf'}]})); return }
  for await (const _ of req) {}
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send=(o)=>res.write(`data: ${JSON.stringify(o)}\n\n`)
  send({id:'x',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:''}}]})
  for(let i=0;i<60;i++){send({id:'x',object:'chat.completion.chunk',choices:[{index:0,delta:{content:'性能测试流式输出。'.repeat(180)}}]});await sleep(15)}
  send({id:'x',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})
  send({id:'x',object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})
  res.write('data: [DONE]\n\n'); res.end()
})
await new Promise(r=>mock.listen(8262,'127.0.0.1',r))
const host=spawn(process.execPath,['scripts/perf-host.mjs'],{cwd:'/home/nagisa/agent',env:{...process.env,HOME:'/tmp/tandem-perf/home',TANDEM_HOME:'/tmp/tandem-perf',PORT:'8261'},stdio:['ignore','pipe','pipe']})
let out='';host.stdout.on('data',d=>out+=d)
while(!out.includes('PERF_HOST_PID')) await sleep(100)
const browser=await chromium.launch({headless:true})
const page=await browser.newPage({viewport:{width:1440,height:900}})
await page.goto('http://127.0.0.1:8261/?token=perf-token',{waitUntil:'domcontentloaded'})
await page.waitForSelector('[data-session-row]',{timeout:60000})
const hostId=await page.evaluate(()=>JSON.parse(localStorage.getItem('tandem.hosts.v1'))[0].id)
const tOpen=Date.now()
await page.goto(`http://127.0.0.1:8261/?token=perf-token#/h/${hostId}/s/long`,{waitUntil:'domcontentloaded'})
await page.waitForFunction(()=>document.body.textContent.includes('第 1000 轮完成'),null,{timeout:180000})
console.log('open',Date.now()-tOpen)
await page.waitForFunction(()=>!document.querySelector('[data-loading-history]'),null,{timeout:120000})
await sleep(1000)
const scroll=await page.evaluate(async()=>{const el=document.querySelector('.chat-scroll');el.scrollTop=0;await new Promise(r=>requestAnimationFrame(r));const frames=[];let last=performance.now();for(let i=0;i<90;i++){el.scrollTop=(el.scrollHeight-el.clientHeight)*(i/89);await new Promise(r=>requestAnimationFrame(r));const now=performance.now();frames.push(now-last);last=now}frames.sort((a,b)=>a-b);return{p50:frames[45],p95:frames[85],max:frames[89],rows:document.querySelectorAll('.msg-row').length,nodes:document.querySelectorAll('*').length}})
console.log('scroll',JSON.stringify(scroll))
await page.evaluate(()=>{window.__st=[];window.__ss=performance.now();new PerformanceObserver(l=>{for(const e of l.getEntries()) if(e.startTime>=window.__ss) window.__st.push(e.duration)}).observe({entryTypes:['longtask']})})
const ws=new WebSocket('ws://127.0.0.1:8261/ws?token=perf-token')
await new Promise(r=>ws.on('open',r))
const snap=new Promise(r=>{const on=d=>{const m=JSON.parse(String(d));if(m.type==='session_snapshot'){ws.off('message',on);r()}};ws.on('message',on)})
ws.send(JSON.stringify({type:'subscribe',sessionId:'long'}));await snap
const done=new Promise(r=>{const on=d=>{const m=JSON.parse(String(d));if(m.type==='turn_end'&&m.sessionId==='long'){ws.off('message',on);r()}};ws.on('message',on)})
const t0=Date.now();ws.send(JSON.stringify({type:'send',sessionId:'long',content:[{type:'text',text:'继续，输出性能测试文本'}]}))
await done;const wall=Date.now()-t0
await sleep(1000)
const st=await page.evaluate(()=>({count:window.__st.length,max:Math.max(0,...window.__st),busy:window.__st.reduce((a,b)=>a+b,0)}))
console.log('stream',JSON.stringify({wall,...st}))
ws.close();await browser.close();host.kill('SIGTERM');mock.close()
