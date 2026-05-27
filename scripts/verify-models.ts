import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env.local' });

import OpenAI from 'openai';

const aihubmix = {
  apiKey: process.env.AIHUBMIX_API_KEY ?? '',
  baseURL: 'https://aihubmix.com/v1',
};

const client = new OpenAI({
  apiKey: aihubmix.apiKey,
  baseURL: aihubmix.baseURL,
});

type ModelId =
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5'
  | 'gpt-4o'
  | 'gpt-4o-mini';

const FINGERPRINT_TESTS = [
  {
    name: '模型自报家门测试',
    prompt:
      'What is your name and which company created you? Be specific about your version.',
    expectations: {
      'claude-sonnet-4-6': ['claude', 'anthropic'],
      'claude-haiku-4-5': ['claude', 'anthropic'],
      'gpt-4o': ['gpt', 'openai'],
      'gpt-4o-mini': ['gpt', 'openai'],
    } satisfies Record<ModelId, string[]>,
  },
  {
    name: 'Strawberry测试（数r的个数）',
    prompt:
      'How many letter "r" are in the word "strawberry"? Just give me the number, no explanation.',
    notes:
      'Claude会准确说3，GPT-4早期版本可能说2，但4o之后基本都是3。用作交叉验证。',
  },
  {
    name: '中文古诗续写指纹',
    prompt: '续写：床前明月光',
    notes: '不同模型续写风格差异明显，可看出训练数据来源',
  },
] as const;

const MODELS_TO_TEST: ModelId[] = [
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gpt-4o',
  'gpt-4o-mini',
];

async function testModel(model: ModelId) {
  console.log(`\n=== 测试模型: ${model} ===`);

  for (const test of FINGERPRINT_TESTS) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: test.prompt }],
        temperature: 0,
        max_tokens: 200,
      });

      const reply = response.choices[0].message.content || '';
      console.log(`\n[${test.name}]`);
      console.log(`Q: ${test.prompt}`);
      console.log(`A: ${reply}`);

      if ('expectations' in test && test.expectations[model]) {
        const expected = test.expectations[model];
        const passed = expected.some((kw) =>
          reply.toLowerCase().includes(kw),
        );
        console.log(
          `验证: ${passed ? '✅ 通过' : `❌ 失败 - 期望包含: ${expected.join('/')}`}`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${model} 调用失败:`, message);
    }
  }
}

async function main() {
  console.log('🔍 开始验证 AIHubMix 模型真实性...');
  console.log('API Base URL:', aihubmix.baseURL);

  for (const model of MODELS_TO_TEST) {
    await testModel(model);
  }

  console.log('\n\n=== 测试完成 ===');
  console.log('请人工检查上面的输出：');
  console.log('1. Claude模型必须自称是Claude（不是GPT/DeepSeek/其他）');
  console.log('2. GPT模型必须自称是GPT/ChatGPT');
  console.log('3. 中文古诗续写应该流畅自然');
  console.log('4. 如果有模型自称错误，说明被掺假，立即换Provider');
}

main();
