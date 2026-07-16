import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env.local' });

import { createScriptAdminClient } from './lib/supabase-admin';

async function main() {
  const admin = createScriptAdminClient();
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data } = await admin
    .from('messages')
    .select('cost_usd, total_tokens, model_used')
    .gte('created_at', firstDay);

  if (!data) return;

  const totalCost = data.reduce((sum, m) => sum + Number(m.cost_usd), 0);
  const totalTokens = data.reduce((sum, m) => sum + m.total_tokens, 0);

  console.log('=== 本月统计 ===');
  console.log('消息数:', data.length);
  console.log('总 Token:', totalTokens.toLocaleString());
  console.log('总成本(USD):', totalCost.toFixed(4));
  console.log('总成本(CNY约):', (totalCost * 7).toFixed(2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
