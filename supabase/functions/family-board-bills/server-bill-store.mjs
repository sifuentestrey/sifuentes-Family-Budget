import {householdDate,shiftMonth} from './smart-bills.mjs';

async function pages(query) {
  const rows=[];
  for(let offset=0;offset<12000;offset+=500) {
    const {data,error}=await query().range(offset,offset+499);
    if(error)throw error;
    rows.push(...(data||[]));if((data||[]).length<500)return rows;
  }
  throw new Error('History exceeds the loading limit.');
}
export function createServerBillAccess(client) {
  return {
    async readConfig() {
      const {data,error}=await client.rpc('family_board_bill_bridge_config');
      if(error||data?.length!==1)throw new Error('Bill connection unavailable.');
      return data[0];
    },
    async readSnapshot(config) {
      const household=config.household_id,coverageStart=shiftMonth(householdDate().slice(0,7),-12)+'-01';
      const [events,transactions,accounts,items]=await Promise.allSettled([
        pages(()=>client.from('family_board_bill_events').select('id,kind,data,created_at').eq('household_id',household).order('created_at',{ascending:true}).order('id',{ascending:true})),
        pages(()=>client.from('transactions').select('id,plaid_transaction_id,account_id,posted_date,amount,payee,raw_description,pending,is_transfer,is_income,parent_transaction_id').eq('household_id',household).gte('posted_date',coverageStart).order('posted_date',{ascending:true}).order('id',{ascending:true})),
        client.from('accounts').select('id,nickname,type,updated_at').eq('household_id',household),
        client.from('items').select('status').eq('household_id',household)
      ]);
      if(events.status!=='fulfilled')throw new Error('Saved bill choices unavailable.');
      if(transactions.status!=='fulfilled'||accounts.status!=='fulfilled'||items.status!=='fulfilled'||accounts.value.error||items.value.error)
        return {events:events.value,transactions:[],accounts:[],source:{available:false,coverageStart}};
      const a=accounts.value.data||[],i=items.value.data||[];
      return {events:events.value,transactions:transactions.value,accounts:a,source:{
        available:a.length>0&&i.length>0,coverageStart,updatedAt:a.map(v=>v.updated_at).filter(Boolean).sort().at(-1)||null,
        needsReconnect:i.some(v=>v.status!=='good'),connections:i.length
      }};
    },
    async appendEvent(config,kind,data,id) {
      const columns='id,kind,data,created_at';
      const {data:row,error}=await client.from('family_board_bill_events').insert({id,household_id:config.household_id,created_by:config.actor_user_id,kind,data}).select(columns).single();
      if(error?.code==='23505') {
        const existing=await client.from('family_board_bill_events').select(columns).eq('household_id',config.household_id).eq('id',id).single();
        if(!existing.error&&existing.data)return existing.data;
      }
      if(error)throw new Error('Bill choice could not be saved.');
      return row;
    }
  };
}
