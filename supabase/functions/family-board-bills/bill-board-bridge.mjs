import {buildMonthlyBillView,cleanRule,householdDate,normalizeEvent,providerKey,validDate,validMonth} from './smart-bills.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const cents=v=>v===null||Number.isSafeInteger(v)&&v>=0&&v<=1000000000;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
export async function tokenHash(token) {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
  return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function equalHash(a,b) {
  if(!/^[0-9a-f]{64}$/.test(a||'')||!/^[0-9a-f]{64}$/.test(b||''))return false;
  let different=0;for(let i=0;i<64;i++)different|=a.charCodeAt(i)^b.charCodeAt(i);return different===0;
}
export function cleanBillChange(kind,data) {
  if(!data||typeof data!=='object'||Array.isArray(data)||!normalizeEvent({kind,data}))throw new Error('Invalid bill choice.');
  const base={bid:data.bid,month:data.month};
  if(kind==='billSet') {
    const rule=cleanRule(data);if(!rule.name||own(data,'amountCents')&&!cents(data.amountCents))throw new Error('Invalid bill settings.');
    return {...base,...rule};
  }
  if(kind==='billRemove')return base;
  if(kind==='billMonth') {
    const result={...base},rule=cleanRule(data);
    for(const field of ['name','dueDay','autoPay'])if(own(data,field))result[field]=rule[field];
    if(own(data,'amountCents')){if(!cents(data.amountCents))throw new Error('Invalid amount.');result.amountCents=data.amountCents;}
    return result;
  }
  if(kind==='billPaid') {
    if(own(data,'paidCents')&&!cents(data.paidCents))throw new Error('Invalid amount.');
    return {...base,v:data.v,paidDate:validDate(data.paidDate)?data.paidDate:'',paidCents:data.paidCents??null};
  }
  if(typeof data.transactionId!=='string'||data.transactionId.length>100||!data.transactionId)throw new Error('Invalid payment.');
  if(kind==='billExclude')return {...base,transactionId:data.transactionId,v:!!data.v};
  if(!Number.isSafeInteger(data.cents)||!cents(data.cents))throw new Error('Invalid payment amount.');
  return {...base,transactionId:data.transactionId,cents:data.cents,paidDate:validDate(data.paidDate)?data.paidDate:'',
    payee:String(data.payee||'').slice(0,120),fullyPaid:data.fullyPaid===true,rememberPayee:data.rememberPayee===true};
}
function paymentSummary(t) {
  return {id:t.id||t.transactionId,transactionId:t.transactionId,cents:t.cents,postedDate:t.postedDate||t.paidDate,
    payee:t.payee,pending:!!t.pending,is_income:!!t.is_income,is_transfer:!!t.is_transfer,
    confirmed:!!t.confirmed,automatic:!!t.automatic};
}
export function boardBillSnapshot(snapshot,month,asOf) {
  const view=buildMonthlyBillView({...snapshot,month,asOf});
  const aliases=new Set(Object.values(view.state.series).flatMap(s=>s.versions.flatMap(v=>v.rule.aliases)));
  const allocated=new Set(Object.values(view.state.allocations).map(a=>a.transactionId));
  const transactions=view.transactions.filter(t=>allocated.has(t.id)||aliases.has(providerKey(t.payee))||aliases.has(providerKey(t.raw_description))).map(paymentSummary);
  return {events:[],transactions:[],asOf,accounts:(snapshot.accounts||[]).map(a=>({id:a.id,nickname:a.nickname,type:a.type})),source:snapshot.source,
    view:{...view,rows:view.rows.map(r=>({...r,payments:r.payments.map(paymentSummary),candidates:r.candidates.map(paymentSummary)})),
      transactions,allocatedTotals:[...view.allocatedTotals]}};
}
export async function matchEventId(transactionId) {
  const hex=await tokenHash('family-board-bill-match:'+transactionId),bytes=hex.match(/../g).slice(0,16).map(v=>parseInt(v,16));
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const value=bytes.map(b=>b.toString(16).padStart(2,'0')).join('');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
export function createBillBridgeHandler(access,now=()=>new Date()) {
  return async request=>{
    if(request.method!=='POST')return reply({error:'Use POST.'},405);
    const token=request.headers.get('x-family-board-token')||'';
    if(!/^[0-9a-f]{64}$/.test(token))return reply({error:'Unauthorized.'},401);
    try {
      const config=await access.readConfig();
      if(!config.enabled||!equalHash(await tokenHash(token),config.token_sha256))return reply({error:'Unauthorized.'},401);
      const text=await request.text();if(text.length>24000)return reply({error:'Bill choice is too large.'},413);
      let body;try{body=JSON.parse(text);}catch{return reply({error:'Invalid request.'},400);}
      if(body?.action==='append') {
        let data;try{if(!uuid(body.id))throw new Error();data=cleanBillChange(body.kind,body.data);}catch{return reply({error:'Invalid bill choice.'},400);}
        const event=await access.appendEvent(config,body.kind,data,body.id);
        return reply({event});
      }
      if(body?.action!=='read'||!validMonth(body.month))return reply({error:'Choose a valid bill month.'},400);
      const snapshot=await access.readSnapshot(config),asOf=householdDate(now());
      if(snapshot.source.available!==false) {
        const view=buildMonthlyBillView({...snapshot,month:body.month,asOf});
        for(const row of view.rows.filter(r=>r.status==='paid'&&!r.manual))for(const p of row.payments.filter(p=>!p.confirmed)) {
          const event=await access.appendEvent(config,'billAllocation',{bid:row.bid,month:row.month,transactionId:p.id,cents:p.cents,
            paidDate:p.postedDate,payee:p.payee,automatic:true},await matchEventId(p.id));
          snapshot.events.push(event);
        }
      }
      return reply(boardBillSnapshot(snapshot,body.month,asOf));
    }catch{return reply({error:'Bill updates are temporarily unavailable.'},503);}
  };
}
