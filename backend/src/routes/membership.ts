// 舊 Whop 會籍（日票 / 月票 / Telegram VIP）已於 2026-10-23 停用。
//
// 唯一付費產品係 tianxi.racing 上嘅 HK$78/週 Stripe 訂閱（由 Lovable 前端 + Supabase 管理）。
// 呢個 Worker 唔再處理任何會籍登入、結帳或 Telegram 入場。
//
// 保留 /api/membership/* 同 /pro 路徑，只係為咗：
//   * 舊連結（電郵、Telegram、書籤）唔會 404，而係清楚話俾用戶知去邊度。
//   * 唔會再 303 轉去 Whop 結帳。
//
// D1 表 membership_oauth_states / membership_sessions / membership_entitlements
// 刻意保留（不 DROP、不改），方便日後對帳；本檔已唔再讀寫佢哋。

import { Hono } from 'hono';
import type { Env } from '../types';

export const MEMBERSHIP_URL = 'https://tianxi.racing/membership';

export const LEGACY_MEMBERSHIP_GONE = {
  error: 'membership_moved',
  message: '舊會籍系統（Whop 日票／月票／Telegram VIP）已停用。請到 tianxi.racing 會員頁登記或管理 Pro 訂閱。',
  membershipUrl: MEMBERSHIP_URL,
} as const;

export const membershipRoutes = new Hono<{ Bindings: Env }>();

membershipRoutes.all('*', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(LEGACY_MEMBERSHIP_GONE, 410);
});

export const proRoutes = new Hono<{ Bindings: Env }>();

proRoutes.all('*', (c) => c.redirect(MEMBERSHIP_URL, 301));
