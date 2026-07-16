import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { message: 'Auth API — Supabase 会话桥接' },
    { status: 501 },
  );
}
