import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {createServerBillAccess} from './server-bill-store.mjs';
import {createBillBridgeHandler} from './bill-board-bridge.mjs';

// The service credential stays inside Supabase. The Board has a separate,
// household-scoped token which can only read this bill view and append choices.
const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{
  auth:{persistSession:false,autoRefreshToken:false}
});
Deno.serve(createBillBridgeHandler(createServerBillAccess(client)));
