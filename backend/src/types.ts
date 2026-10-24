// 天喜娛樂 Backend Types

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  WEATHER_CRON_SECRET?: string;
  SESSION_HMAC_SECRET?: string;
  /** 愛駒追蹤 feed 共享密鑰（未設定時退回 WEATHER_CRON_SECRET）。 */
  WATCH_FEED_SECRET?: string;
  /** 輪換期間仍接受嘅上一個 WATCH_FEED_SECRET。 */
  WATCH_FEED_SECRET_PREVIOUS?: string;
  /** Worker → 網站 /api/public/telegram-alert 專用密鑰（未設定時退回 WEATHER_CRON_SECRET）。 */
  ALERT_HOOK_SECRET?: string;
  /** 'off' = WATCH feed 唔再接受舊 WEATHER_CRON_SECRET。預設（未設定）= 接受，方便過渡。 */
  LEGACY_CRON_SECRET_FALLBACK?: string;
  ADMIN_GITHUB_USER?: string;
  AI_API_KEY: string;
  AI_API_URL: string;
  AI_MODEL: string;
  TIMESFM_API_URL: string;
  TIMESFM_API_KEY: string;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  /** 每次 AI 呼叫 max_tokens 上限（預設 1500，硬上限 3000）。 */
  AI_MAX_TOKENS?: string;
  /** '1' = 暫停 /api/chat（緊急開關）。 */
  CHAT_DISABLED?: string;
  /** Supabase 專案網址（公開），用嚟核實 JWT（JWKS）同讀會籍。 */
  SUPABASE_URL?: string;
  /** Supabase publishable／anon key（公開 key，唔係 service role）；只喺 PRO_ENTITLEMENT_MODE=on 時需要。 */
  SUPABASE_PUBLISHABLE_KEY?: string;
  /** 'live' | 'sandbox'，要同網站付款環境一致。 */
  PAYMENTS_ENVIRONMENT?: string;
  /** 'on' = 接受已核實 Pro JWT 直接讀全部場次；預設 off（同現況一樣）。 */
  PRO_ENTITLEMENT_MODE?: string;
  /** 額外 CORS origin（逗號分隔）。 */
  CORS_EXTRA_ORIGINS?: string;
}

// =============================================
// Database Row Types
// =============================================

export interface RaceMeetingRow {
  id: string;
  date: string;
  venue: string;
  track_condition: string | null;
  weather: string | null;
  total_races: number | null;
}

export interface RaceRow {
  id: string;
  meeting_id: string;
  race_number: number;
  title: string | null;
  class: string | null;
  distance: number | null;
  going: string | null;
  track: string | null;
  course: string | null;
  prize: string | null;
  start_time: string | null;
  video_url: string | null;
}

export interface HorseRow {
  id: string;
  name_en: string;
  name_ch: string | null;
  code: string | null;
  country_of_origin: string | null;
  colour: string | null;
  sex: string | null;
  age: number | null;
  sire: string | null;
  dam: string | null;
  dam_sire: string | null;
  import_type: string | null;
  current_trainer_id: string | null;
  current_rating: number | null;
  season_stakes: number;
  total_wins: number;
  total_starts: number;
  status: string;
}

export interface RaceResultRow {
  id: string;
  race_id: string;
  horse_id: string;
  horse_number: number | null;
  finishing_position: number | null;
  draw: number | null;
  jockey_id: string | null;
  trainer_id: string | null;
  actual_weight: number | null;
  declared_weight: number | null;
  handicap_weight: number | null;
  lbw: string | null;
  running_position: string | null;
  finish_time: number | null;
  win_odds: number | null;
  gear: string | null;
  race_class_rating: number | null;
}

// =============================================
// API Response Types
// =============================================

export interface MeetingResponse {
  id: string;
  date: string;
  venue: string;
  venueName: string;
  trackCondition: string | null;
  weather: string | null;
  totalRaces: number;
  races: RaceResponse[];
}

export interface RaceResponse {
  id: string;
  raceNumber: number;
  title: string | null;
  class: string | null;
  distance: number | null;
  going: string | null;
  track: string | null;
  course: string | null;
  prize: string | null;
  startTime: string | null;
  videoUrl: string | null;
  horses: HorseInRaceResponse[];
}

export interface HorseInRaceResponse {
  id: string;
  horseNumber: number;
  name: string;
  nameCh: string | null;
  draw: number;
  jockey: string | null;
  jockeyCh: string | null;
  trainer: string | null;
  trainerCh: string | null;
  finishingPosition: number | null;
  finishTime: number | null;
  winOdds: number | null;
  runningPosition: string | null;
  lbw: string | null;
  gear: string | null;
  weight: number | null;
}

export interface HorseFormResponse {
  horse: {
    id: string;
    nameEn: string;
    nameCh: string | null;
    code: string | null;
    sire: string | null;
    dam: string | null;
    damSire: string | null;
    age: number | null;
    sex: string | null;
    currentRating: number | null;
    totalWins: number | null;
    totalSeconds: number | null;
    totalThirds: number | null;
    totalStarts: number | null;
  };
  recentForm: {
    date: string;
    venue: string;
    raceNumber: number;
    distance: number;
    class: string | null;
    going: string | null;
    position: number | null;
    draw: number | null;
    finishTime: number | null;
    winOdds: number | null;
    runningPosition: string | null;
    lbw: string | null;
    gear: string | null;
    jockey: string | null;
    trainer: string | null;
  }[];
}

// =============================================
// AI / Analysis Types
// =============================================

export interface ChatRequest {
  message: string;
  raceDate?: string;
  raceNumber?: number;
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
}

export interface ChatResponse {
  message: string;
  metadata?: {
    raceDate?: string;
    raceNumber?: number;
    factors?: string[];
    betType?: string;
  };
}

export interface AnalyzeRequest {
  raceId: string;
  factors: string[];
}

export interface TimesFMPrediction {
  factorName: string;
  factorNameCn: string;
  trendDirection: 'up' | 'down' | 'stable';
  confidence: number;
  insight: string;
  values?: number[];
}

export interface AnalysisRecommendation {
  type: string;
  picks: string;
  reason: string;
  confidence: number;
}

export interface AnalyzeResponse {
  timesfmResults: TimesFMPrediction[];
  aiSummary: string;
  recommendations: AnalysisRecommendation[];
  overallConfidence: number;
}
