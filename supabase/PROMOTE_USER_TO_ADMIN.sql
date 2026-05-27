-- 将已有用户提升为超级管理员（在 SQL Editor 执行）
-- 把 your@email.com 换成你的登录邮箱

update public.user_profiles
set
  role = 'super_admin',
  updated_at = now()
where id = (
  select id
  from auth.users
  where email = 'your@email.com'
  limit 1
);

-- 验证
select up.id, u.email, up.name, up.role
from public.user_profiles as up
join auth.users as u on u.id = up.id
where u.email = 'your@email.com';
