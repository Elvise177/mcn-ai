export const adminFetcher = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || '请求失败');
  }
  return body as T;
};
