import type { ChatMessage, ChatRole, Conversation } from '@/types/chat';

export const MOCK_ROLES: ChatRole[] = [
  { id: 'role-beauty', name: '美妆顾问', icon: '💄' },
  { id: 'role-copy', name: '带货文案', icon: '✍️' },
  { id: 'role-product', name: '选品分析', icon: '📦' },
];

export const MOCK_USER_EMAIL = 'demo@mcn-ai.com';

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: 'conv-1',
    title: '春季口红选品与话术',
    roleId: 'role-beauty',
    updatedAt: new Date(Date.now() - 1000 * 60 * 45),
  },
  {
    id: 'conv-2',
    title: '直播间开场白优化',
    roleId: 'role-copy',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 3),
  },
  {
    id: 'conv-3',
    title: '竞品面膜数据分析',
    roleId: 'role-product',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
  },
  {
    id: 'conv-4',
    title: '敏感肌护肤推荐方案',
    roleId: 'role-beauty',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
  },
];

export const MOCK_MESSAGES: Record<string, ChatMessage[]> = {
  'conv-1': [
    {
      id: 'msg-1',
      role: 'user',
      content: '帮我分析一下适合春季推广的口红品类，目标人群是 25-35 岁都市女性。',
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: `好的，针对 **25-35 岁都市女性** 的春季口红推广，建议关注以下方向：

## 热门色系
- **豆沙色 / 烟粉**：日常通勤，低饱和显气质
- **烂番茄 / 枫叶红**：黄皮友好，上镜效果好
- **水光唇釉**：春季清透感，适合短视频展示

## 话术要点
1. 强调「一支搞定通勤+约会」
2. 突出持妆与不拔干
3. 结合「春季换新妆」场景做限时组合

需要我帮你写一段 30 秒的直播口播吗？`,
    },
    {
      id: 'msg-3',
      role: 'user',
      content: '可以，写一段 30 秒口播，语气要亲切专业。',
    },
    {
      id: 'msg-4',
      role: 'assistant',
      content:
        '姐妹们春天到啦！这支豆沙色真的绝——薄涂是温柔日常，厚涂气场全开，黄皮也能轻松驾驭。质地滋润不拔干，上班通勤、周末约会一支搞定。今天直播间下单还送同系列唇线笔，库存不多，喜欢的姐妹赶紧冲！',
    },
  ],
  'conv-2': [
    {
      id: 'msg-5',
      role: 'user',
      content: '帮我优化一下直播间开场白，要更有吸引力。',
    },
    {
      id: 'msg-6',
      role: 'assistant',
      content:
        '欢迎来到直播间！今天给大家带来了 **限时福利专场**——所有链接都是全网低价，错过真的要等很久。新来的姐妹点个关注，老粉们把「想要」打在公屏上，我们马上开始！',
    },
  ],
  'conv-3': [
    {
      id: 'msg-7',
      role: 'user',
      content: '对比分析一下市面上三款热门补水面膜的优缺点。',
    },
    {
      id: 'msg-8',
      role: 'assistant',
      content:
        '可以从 **成分、价格带、复购率、直播转化** 四个维度做对比。A 款胜在性价比，B 款品牌力强，C 款适合敏感肌细分。需要我输出表格版对比吗？',
    },
  ],
  'conv-4': [],
};
