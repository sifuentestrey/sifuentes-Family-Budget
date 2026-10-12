/* Monthly bill coverage. Pure functions; never changes a bank transaction. */
export const EVENT_KINDS = ['billSet','billMonth','billPaid','billRemove','billAllocation','billExclude'];
const MAX_CENTS = 1000000000;
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const centsValue = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_CENTS ? n : null;
export function validMonth(v) { return typeof v === 'string' && /^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/.test(v); }
export function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !validMonth(v.slice(0,7))) return false;
  const d = new Date(v+'T00:00:00Z');
  return Number.isFinite(+d) && d.toISOString().slice(0,10) === v;
}
export function householdDate(value = new Date()) {
  const d = new Date(value);
  if (!Number.isFinite(+d)) return '';
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const part = k => parts.find(p=>p.type===k).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function shiftMonth(month,n) {
  if (!validMonth(month) || !Number.isInteger(n)) return '';
  const d = new Date(month+'-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth()+n);
  const next = d.toISOString().slice(0,7); return validMonth(next) ? next : '';
}
export function amountToCents(v) {
  if (v == null || v === '') return null;
  const match = String(v).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const n = (Number(match[2])*100+Number((match[3]||'').padEnd(2,'0'))) * (match[1] ? -1 : 1);
  return Number.isSafeInteger(n) && Math.abs(n) <= MAX_CENTS ? n : null;
}
export function providerKey(v) {
  // Exact normalized aliases. Do not guess using a merchant's first word.
  return String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function aliases(v) { return [...new Set((Array.isArray(v)?v:[]).slice(0,12).map(x=>providerKey(String(x).slice(0,120))).filter(Boolean))]; }
export function cleanRule(v) {
  return {
    name:String(v.name||'').trim().slice(0,80), amountCents:centsValue(v.amountCents),
    dueDay:Number.isInteger(v.dueDay)&&v.dueDay>=1&&v.dueDay<=31?v.dueDay:null,
    aliases:aliases(v.aliases), accountId:String(v.accountId||'').slice(0,100),
    reference:providerKey(v.reference).slice(0,80), kind:v.kind==='card'?'card':'standard',
    amountMode:v.amountMode==='variable'?'variable':'fixed', autoPay:!!v.autoPay,
    earlyDays:Number.isInteger(v.earlyDays)&&v.earlyDays>=0&&v.earlyDays<=90?v.earlyDays:35,
    lateDays:Number.isInteger(v.lateDays)&&v.lateDays>=0&&v.lateDays<=90?v.lateDays:31
  };
}
export function normalizeEvent(row) {
  const data = row.data || row;
  const t = row.data ? row.kind : data.t;
  if (!EVENT_KINDS.includes(t) || !validMonth(data.month) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(data.bid||'')) return null;
  if(t==='billPaid' && data.v!==true && data.v!==false && data.v!==null)return null;
  return {...data,t,id:row.id||data.id||'',order:String(row.created_at||data.order||''),ts:Number(data.ts)||0};
}
export function foldBillEvents(events=[]) {
  const state = {series:Object.create(null),months:Object.create(null),allocations:Object.create(null),exclusions:Object.create(null)};
  const unique = new Map();
  events.forEach((row,i)=>{const e=normalizeEvent(row);if(e)unique.set(e.id||`legacy-${i}`,e);});
  const sorted = [...unique.values()].sort((a,b)=>a.order.localeCompare(b.order)||a.ts-b.ts||a.id.localeCompare(b.id));
  for (const e of sorted) {
    const key = `${e.bid}|${e.month}`;
    if(e.t==='billSet'||e.t==='billRemove') {
      const rule = cleanRule(e);
      if(e.t==='billSet' && !rule.name)continue;
      const series=state.series[e.bid]||{bid:e.bid,versions:[]};
      series.versions=series.versions.filter(v=>e.t==='billRemove'?v.from<e.month:v.from!==e.month)
        .concat({from:e.month,rule,removed:e.t==='billRemove'}).sort((a,b)=>a.from.localeCompare(b.from));
      state.series[e.bid]=series;
    } else if(e.t==='billMonth') {
      const r=state.months[key]||{};
      const patch={};
      for(const field of ['name','dueDay','autoPay'])if(own(e,field))patch[field]=cleanRule(e)[field];
      if(own(e,'amountCents')) { patch.amountCents=centsValue(e.amountCents);patch.amountVerified=patch.amountCents!==null; }
      state.months[key]={...r,...patch};
    } else if(e.t==='billPaid') {
      const r=state.months[key]||{};
      state.months[key]={...r,manualPaid:e.v===null?null:!!e.v,paidDate:e.v&&validDate(e.paidDate)?e.paidDate:'',paidCents:centsValue(e.paidCents),manualTransactionId:null};
    } else if(e.t==='billAllocation') {
      if(!e.transactionId || !(centsValue(e.cents)>0 || e.cents===0))continue;
      const allocationKey=`${e.transactionId}|${key}`;
      if(e.cents===0) {
        delete state.allocations[allocationKey];
        if(state.months[key]?.manualTransactionId===e.transactionId)state.months[key]={...state.months[key],manualPaid:null,manualTransactionId:null,paidDate:'',paidCents:null};
      }
      else {
        state.allocations[allocationKey]={bid:e.bid,month:e.month,transactionId:String(e.transactionId),cents:e.cents,paidDate:validDate(e.paidDate)?e.paidDate:'',payee:String(e.payee||'').slice(0,120),automatic:e.automatic===true};
        if(!e.automatic)state.months[key]={...(state.months[key]||{}),manualPaid:e.fullyPaid===true?true:null,manualTransactionId:e.fullyPaid===true?e.transactionId:null,
          ...(e.fullyPaid===true?{paidDate:validDate(e.paidDate)?e.paidDate:'',paidCents:e.cents}:{})};
        // An accepted alias is an explicit household correction, effective from this month.
        const current=occurrence(state,e.bid,e.month);
        if(e.rememberPayee && current && providerKey(e.payee)) {
          const series=state.series[e.bid];
          const base=series.versions.filter(v=>v.from<=e.month).at(-1).rule;
          const rule=cleanRule({...base,aliases:[...base.aliases,e.payee]});
          series.versions=series.versions.filter(v=>v.from!==e.month).concat({from:e.month,rule}).sort((a,b)=>a.from.localeCompare(b.from));
        }
      }
    } else if(e.t==='billExclude') {
      if(e.transactionId)state.exclusions[`${e.transactionId}|${key}`]=!!e.v;
    }
  }
  return state;
}
export function occurrence(state,bid,month) {
  if(!validMonth(month))return null;
  const version=state.series[bid]?.versions.filter(v=>v.from<=month).at(-1);
  if(!version || version.removed)return null;
  const override=state.months[`${bid}|${month}`]||{};
  const rule={...version.rule,...override};
  const lastDay=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate();
  const dueDate=rule.dueDay?`${month}-${String(Math.min(lastDay,rule.dueDay)).padStart(2,'0')}`:'';
  const requiredCents=rule.amountMode==='variable'&&!override.amountVerified?null:rule.amountCents;
  return {...rule,bid,month,key:`${bid}|${month}`,dueDate,requiredCents};
}
function days(a,b) { return (Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000; }
export function normalizeTransactions(rows=[]) {
  const byId=new Map();
  for(const r of rows) {
    const cents=own(r,'cents')?r.cents:amountToCents(r.amount);
    const date=r.posted_date||r.postedDate;
    if(!r.id||!validDate(date)||!Number.isSafeInteger(cents)||Math.abs(cents)>MAX_CENTS||r.parent_transaction_id)continue;
    const identity=r.plaid_transaction_id||r.id;
    byId.set(identity,{...r,cents,postedDate:date,payee:String(r.payee||r.raw_description||''),pending:!!r.pending});
  }
  return [...byId.values()];
}
function providerMatches(b,t) {
  return b.aliases.some(a=>a===providerKey(t.payee)||a===providerKey(t.raw_description))
    && (!b.accountId || b.accountId===t.account_id)
    && (!b.reference || providerKey(t.raw_description).includes(b.reference));
}
function dateMatches(b,t) { const delta=days(b.dueDate,t.postedDate);return Number.isFinite(delta)&&delta>=-b.earlyDays&&delta<=b.lateDays; }
export function buildMonthlyBillView({events=[],transactions=[],month,asOf=householdDate(),source={available:true}}={}) {
  if(!validMonth(month)||!validDate(asOf))throw new Error('A valid bill month and household date are required.');
  const state=foldBillEvents(events), tx=normalizeTransactions(transactions), byId=new Map(tx.map(t=>[t.id,t]));
  const all=[];
  for(let offset=-4;offset<=4;offset++) {
    const m=shiftMonth(month,offset);if(!m)continue;
    for(const bid of Object.keys(state.series)){
      const b=occurrence(state,bid,m);if(b)all.push(b);
      else {
        // Before onboarding, a similar payment may have settled the prior month.
        // Keep that possibility in the matching graph rather than silently crediting
        // the new checklist with an old month's payment.
        const first=state.series[bid].versions[0];
        if(first&&!first.removed&&shiftMonth(m,1)===first.from) {
          const virtual={series:{[bid]:{versions:[{...first,from:m}]}},months:{}};
          all.push({...occurrence(virtual,bid,m),untracked:true});
        }
      }
    }
  }
  const allocations=Object.values(state.allocations), allocatedTotals=new Map();
  for(const a of allocations)allocatedTotals.set(a.transactionId,(allocatedTotals.get(a.transactionId)||0)+a.cents);
  const reservedManual=new Set(),anchoredManual=new Set();
  for(const b of all.filter(b=>b.manualPaid===true)) {
    const matches=tx.filter(t=>!t.pending&&!t.is_income&&t.cents>0&&t.postedDate<=asOf
      && b.paidDate===t.postedDate&&providerMatches(b,t)&&t.cents===(b.paidCents??b.requiredCents));
    if(matches.length===1){reservedManual.add(matches[0].id);anchoredManual.add(b.key);}
  }
  const candidates=new Map(), claims=new Map();
  for(const b of all) {
    const assigned=allocations.filter(a=>a.bid===b.bid&&a.month===b.month);
    const fullyAssigned=b.requiredCents>0&&assigned.reduce((n,a)=>n+a.cents,0)===b.requiredCents&&assigned.every(a=>{
      const t=byId.get(a.transactionId);return t?!t.pending&&t.cents>0&&allocatedTotals.get(t.id)<=t.cents&&t.postedDate<=asOf
        : a.paidDate&&a.paidDate<=asOf&&(!source.coverageStart||a.paidDate<source.coverageStart||source.available===false);
    });
    // A manual check without identified bank evidence may have been recorded days
    // after payment. Keep its possible payments ambiguous for adjoining months.
    const list = anchoredManual.has(b.key) || fullyAssigned || !b.dueDate || !b.aliases.length || source.available===false ? [] : tx.filter(t=>
      t.cents>0 && !t.is_income && (!t.is_transfer||b.kind==='card') && t.postedDate<=asOf
      && !allocatedTotals.has(t.id) && !reservedManual.has(t.id) && !state.exclusions[`${t.id}|${b.key}`] && providerMatches(b,t) && dateMatches(b,t));
    candidates.set(b.key,list);
    if(b.manualPaid!==false)for(const t of list) { const owners=claims.get(t.id)||[];owners.push(b.key);claims.set(t.id,owners); }
  }
  const rows=all.filter(b=>b.month===month&&!b.untracked).map(b=>{
    const selected=allocations.filter(a=>a.bid===b.bid&&a.month===month);
    const potential=candidates.get(b.key)||[];
    const result={...b,status:'not_found',label:'Not found yet',reason:'No matching payment found.',paidCents:0,remainingCents:b.requiredCents,paidDate:'',payments:[],candidates:potential};
    const linked=byId.get(b.manualTransactionId);
    if(b.manualPaid===true) {
      if(b.paidDate>asOf || linked?.pending)return {...result,status:'pending',label:'Payment pending',reason:'The confirmed payment date has not arrived or the bank still reports it pending.'};
      if(b.manualTransactionId&&linked&&(linked.cents<=0||allocatedTotals.get(linked.id)>linked.cents))return {...result,status:'review',label:'Check payment',reason:'The confirmed payment changed or was allocated more than once.'};
      if(b.manualTransactionId&&!linked&&source.available!==false&&source.coverageStart&&b.paidDate>=source.coverageStart)return {...result,status:'review',label:'Check payment',reason:'The recently confirmed bank payment could no longer be found.'};
      if(b.manualTransactionId&&source.available!==false&&b.dueDate&&tx.some(t=>t.cents<0&&!t.is_income&&providerMatches(b,t)&&dateMatches(b,t)))return {...result,status:'review',label:'Check payment',reason:'A refund or returned payment needs checking.'};
      return {...result,status:'paid',label:'Paid',reason:'Confirmed by you.',paidCents:b.paidCents??b.requiredCents,remainingCents:0,paidDate:b.paidDate,manual:true};
    }
    if(b.manualPaid===false)return {...result,reason:'You marked this month as still open.',manual:true};
    const invalidAllocation=selected.some(a=>{
      const t=byId.get(a.transactionId);
      return t ? (t.cents<=0 || t.is_income || allocatedTotals.get(t.id)>t.cents)
        : source.available!==false && source.coverageStart && a.paidDate>=source.coverageStart && a.paidDate<=asOf;
    });
    if(invalidAllocation)return {...result,status:'review',label:'Check payment',reason:'An assigned payment was returned, changed, or allocated more than once.'};
    const explicit=selected.map(a=>{
      const t=byId.get(a.transactionId);
      return {...a,id:a.transactionId,pending:!!t?.pending||(t?.postedDate||a.paidDate)>asOf,postedDate:t?.postedDate||a.paidDate,confirmed:true};
    });
    const uncertain=potential.some(t=>(claims.get(t.id)||[]).length>1);
    const returned=source.available!==false && b.dueDate && tx.some(t=>t.cents<0&&!t.is_income&&providerMatches(b,t)&&dateMatches(b,t));
    const reliable=potential.filter(t=>!t.pending&&(claims.get(t.id)||[]).length===1);
    const payments=explicit.filter(t=>!t.pending).concat(reliable);
    const paidCents=payments.reduce((sum,t)=>sum+t.cents,0);
    const paidDate=payments.map(t=>t.postedDate).filter(validDate).sort().at(-1)||'';
    const pending=potential.some(t=>t.pending)||explicit.some(t=>t.pending);
    Object.assign(result,{paidCents,paidDate,payments,remainingCents:b.requiredCents==null?null:Math.max(0,b.requiredCents-paidCents)});
    if(returned)return {...result,status:'review',label:'Check payment',reason:'A refund or returned payment needs checking.'};
    const explicitlyPaid=explicit.filter(t=>!t.pending).reduce((sum,t)=>sum+t.cents,0);
    if(b.requiredCents>0 && explicitlyPaid===b.requiredCents)return {...result,status:'paid',label:'Paid',reason:explicit.some(p=>!p.automatic)?'Payment assigned by you.':'Matched to a posted bank payment.',paidCents:explicitlyPaid,paidDate:explicit.filter(t=>!t.pending).map(t=>t.postedDate).filter(validDate).sort().at(-1)||'',payments:explicit,remainingCents:0};
    if(uncertain)return {...result,status:'review',label:'Choose bill month',reason:'A payment could cover more than one bill or month.'};
    if(b.requiredCents==null && paidCents>0)return {...result,status:'review',label:'Confirm amount',reason:'A payment was found; the full amount for this month is unknown.'};
    if(b.requiredCents!=null && paidCents>b.requiredCents)return {...result,status:'review',label:'Check payment',reason:'Payments exceed this month’s bill. Choose how they should be allocated.'};
    if(b.requiredCents!=null && paidCents===b.requiredCents && paidCents>0)return {...result,status:'paid',label:'Paid',reason:explicit.length?'Payment assigned by you.':'Matched to a posted bank payment.',remainingCents:0};
    if(paidCents>0)return {...result,status:'partial',label:'Partially paid',reason:pending?'Another payment is pending.':'Part of this month’s bill is covered.'};
    if(pending)return {...result,status:'pending',label:'Payment pending',reason:'Waiting for the payment to post.'};
    if(source.available===false)return {...result,status:'unknown',label:'Bank check unavailable',reason:'Your manual confirmations are saved; bank payments could not be checked.'};
    if(!b.aliases.length||!b.dueDate)return {...result,status:'setup',label:'Finish setup',reason:!b.aliases.length?'Choose the payment name shown by your bank.':'Add the actual due day; payment dates are not due dates.'};
    if(source.coverageStart && b.dueDate < source.coverageStart)return {...result,status:'unknown',label:'History not loaded',reason:'This bill month is outside the loaded bank history.'};
    return result;
  }).sort((a,b)=>(a.dueDate||`${month}-99`).localeCompare(b.dueDate||`${month}-99`)||a.name.localeCompare(b.name));
  return {month,rows,state,transactions:tx,allocatedTotals,counts:{total:rows.length,paid:rows.filter(r=>r.status==='paid').length,partial:rows.filter(r=>r.status==='partial').length,pending:rows.filter(r=>r.status==='pending').length,review:rows.filter(r=>['review','setup'].includes(r.status)).length}};
}
