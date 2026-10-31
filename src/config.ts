export type Config = {
  /** 'dev-defaults' = PROVISIONAL policy values nobody has agreed. 'explicit' = every policy value was set by the operator. */
  policySource: 'dev-defaults' | 'explicit';
  /** Exact JWT `sub` of the deployment owner's verified auth user (paired with the pinned AUTH_ISSUER).
   *  Gates complaint-linked private data (photos, route narrative, org ids, events, disputes, scorecards).
   *  OPTIONAL and fail-closed: when unset, NO principal gets owner access. Set by the deployment owner
   *  after verifying the exact auth.users.id out of band - never inferred from email or roles. */
  mainAdminSubject?: string;
  authIssuer: string;
  authAudience: string;
  authJwksUrl?: string;
  databaseUrl: string;
  /** PROVISIONAL, not agreed. 'officer_review' (safest): new reports wait as 'reported' with a routing SUGGESTION until a municipal officer verifies. 'auto_checks': plausibility checks alone verify and assign. */
  verificationMode: 'officer_review' | 'auto_checks';
  /** Who may see/claim a report that no municipality could be chosen for. 'off' (default) = nobody but the reporter; no cross-city exposure. */
  unroutedTriage: 'off' | 'any_municipal_staff';
  storageDir: string;
  corsOrigins: string[];
  trustProxy: boolean;
  duplicateRadiusM: number;
  roadMatchRadiusM: number;
  evidenceRadiusM: number;
  reportMaxAgeMin: number;
  maxAccuracyM: number;
  dailyReportCap: number;
  dailyPointsCap: number;
  utilityCutWindowDays: number;
  confirmMinAccountAgeHours: number;
  confirmationsToClose: number;
  disputeWindowHours: number;
  level2DelayHours: number;
  publicScorecards: boolean;
  photoRequired: boolean;
  /** Authenticated bridge to the owner's own laptop inference (Qwen via Ollama). Unset = AI off, honestly reported. */
  laptopAiUrl?: string;
  laptopAiToken?: string;
  laptopAiModel: string;
  laptopAiTimeoutMs: number;
  /** Google AI Studio key; when set the assistant routes use Gemini instead of the laptop gateway. Server-side only. */
  /** Explicit assistant provider. 'gemini' routes AI calls to Google (requires GEMINI_API_KEY); anything else keeps the laptop gateway. A parked GEMINI_API_KEY alone never reroutes traffic. */
  aiProvider: 'laptop' | 'gemini';
  geminiApiKey?: string;
  geminiModel: string;
  /** 'off' (default): every /v1/ai/* route refuses, even when LAPTOP_AI_URL is set - hard kill
   *  so a mis-deployed env can never carry real user text/photos to the laptop gateway.
   *  'test': routes enabled for LOCAL synthetic testing only; must never be set on the
   *  production service. Any real-user AI processing needs a separate owner-approved route. */
  // 'off': nothing processed. 'test': synthetic harness only (banned in prod). 'scoped': exact
  // listed subjects only (owner-real lane). 'consented': any signed-in user WITH an active,
  // current-notice, per-feature consent row (db 016) - all-users lane, deny-by-default.
  aiAccessMode: 'off' | 'test' | 'scoped' | 'consented';
  /** Per-principal AI activation scope ('scoped' mode ONLY): exact auth subjects allowed to use AI
   *  routes with real input. Deny-by-default: an unlisted principal gets nothing. Empty in scoped
   *  mode is a boot error - scoped-with-no-subjects must never silently allow or silently work. */
  aiAllowedSubjects: string[];
  /** Product requirement: new reports must bind a staged photo. FALSE during the client rollout window; the deployment owner sets PHOTO_REQUIRED=true once the web client stages photos. Server-enforced when true - no bypass route. */
  rateLimitMax: number;
  /** Follow-up reminder pipeline routes + sweep job. Default OFF; the deployment owner flips FOLLOWUP_PIPELINE=true AFTER migration 011 is applied (coordinated). When off, the routes return 404 and clients show the static honest fallback. */
  followupPipeline: boolean;
};

export function defaults(): Omit<Config, 'authIssuer' | 'authAudience' | 'databaseUrl'> {
  return {
    policySource: 'dev-defaults',
    verificationMode: 'officer_review',
    unroutedTriage: 'off',
    storageDir: './storage',
    corsOrigins: [],
    trustProxy: false,
    duplicateRadiusM: 30, // PRD: "reports within 30 m"
    roadMatchRadiusM: 25, // ASSUMPTION: PRD does not define matching distance
    evidenceRadiusM: 50, // ASSUMPTION
    reportMaxAgeMin: 15, // ASSUMPTION: GPS/time freshness check
    maxAccuracyM: 100, // ASSUMPTION
    dailyReportCap: 10, // ASSUMPTION: PRD says caps exist, no number
    dailyPointsCap: 50, // ASSUMPTION
    utilityCutWindowDays: 90, // ASSUMPTION: PRD says "recent"
    confirmMinAccountAgeHours: 24, // anti-abuse safeguard, not in PRD
    confirmationsToClose: 2, // PRD: 2 confirmations
    disputeWindowHours: 48, // PRD
    level2DelayHours: 48, // ASSUMPTION
    publicScorecards: false, // PRD: legal review before publishing contractor performance
    photoRequired: false, // flipped by the deployment owner after the photo-staging client is live
    laptopAiModel: 'qwen3.5:4b',
    laptopAiTimeoutMs: 25000,
    aiProvider: 'laptop' as const,
    geminiModel: 'gemini-2.5-flash',
    aiAccessMode: 'off',
    aiAllowedSubjects: [] as string[],
    rateLimitMax: 120,
    followupPipeline: false, // flipped by the deployment owner after migration 011 is applied
  };
}

/** Policy values the PRD leaves open. In production each must be set explicitly (env), so a guess never silently becomes live behaviour. */
export const POLICY_KEYS: Record<string, keyof Config> = {
  POLICY_DUPLICATE_RADIUS_M: 'duplicateRadiusM', POLICY_ROAD_MATCH_RADIUS_M: 'roadMatchRadiusM', POLICY_EVIDENCE_RADIUS_M: 'evidenceRadiusM',
  POLICY_REPORT_MAX_AGE_MIN: 'reportMaxAgeMin', POLICY_MAX_ACCURACY_M: 'maxAccuracyM', POLICY_DAILY_REPORT_CAP: 'dailyReportCap',
  POLICY_DAILY_POINTS_CAP: 'dailyPointsCap', POLICY_UTILITY_CUT_WINDOW_DAYS: 'utilityCutWindowDays',
  POLICY_CONFIRM_MIN_ACCOUNT_AGE_HOURS: 'confirmMinAccountAgeHours', POLICY_CONFIRMATIONS_TO_CLOSE: 'confirmationsToClose',
  POLICY_DISPUTE_WINDOW_HOURS: 'disputeWindowHours', POLICY_LEVEL2_DELAY_HOURS: 'level2DelayHours',
};

export function fromEnv(env = process.env): Config {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} required`); return v; };
  const d = defaults();
  const policy: Partial<Config> = {};
  // Hosted TEST deployments on synthetic data only: explicit opt-in to the provisional dev defaults. Never allowed with NODE_ENV=production.
  const devDefaults = env.POLICY_USE_DEV_DEFAULTS === 'synthetic-test-only';
  if (devDefaults && env.NODE_ENV === 'production') throw new Error('POLICY_USE_DEV_DEFAULTS cannot be used with NODE_ENV=production');
  // Fail-closed at boot: the laptop gateway is a synthetic-test harness only. Even if someone
  // sets AI_ACCESS_MODE=test on the production service, the process refuses to start.
  if (env.NODE_ENV === 'production' && env.AI_ACCESS_MODE === 'test')
    throw new Error('AI_ACCESS_MODE=test cannot be used with NODE_ENV=production');
  const aiAllowedSubjects = (env.AI_ALLOWED_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (env.AI_ACCESS_MODE === 'scoped' && aiAllowedSubjects.length === 0)
    throw new Error('AI_ACCESS_MODE=scoped requires AI_ALLOWED_SUBJECTS (exact auth subjects, deny-by-default)');
  if (!devDefaults) for (const [envKey, key] of Object.entries(POLICY_KEYS)) {
    const n = Number(need(envKey));
    if (!Number.isFinite(n) || n < 0) throw new Error(`${envKey} must be a non-negative number`);
    (policy as any)[key] = n;
  }
  const ut = env.POLICY_UNROUTED_TRIAGE ?? 'off';
  if (ut !== 'off' && ut !== 'any_municipal_staff') throw new Error('POLICY_UNROUTED_TRIAGE must be off or any_municipal_staff');
  (policy as any).unroutedTriage = ut;
  const vm = env.POLICY_VERIFICATION_MODE;
  if (!devDefaults && vm !== 'officer_review' && vm !== 'auto_checks') throw new Error('POLICY_VERIFICATION_MODE must be officer_review or auto_checks');
  if (!devDefaults) (policy as any).verificationMode = vm;
  if (!devDefaults && env.POLICY_SPOOF_RESIDENCY_ACK !== 'confirmations-are-not-resident-verification') throw new Error('POLICY_SPOOF_RESIDENCY_ACK must acknowledge that citizen confirmations do not verify residency');
  return {
    ...d, ...policy,
    policySource: devDefaults ? 'dev-defaults' : 'explicit',
    authIssuer: need('AUTH_ISSUER'),
    authAudience: need('AUTH_AUDIENCE'),
    authJwksUrl: need('AUTH_JWKS_URL'),
    databaseUrl: need('DATABASE_URL'),
    storageDir: env.STORAGE_DIR ?? d.storageDir,
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
    publicScorecards: env.PUBLIC_SCORECARDS === 'true',
    photoRequired: env.PHOTO_REQUIRED === 'true',
    laptopAiUrl: env.LAPTOP_AI_URL || undefined,
    laptopAiToken: env.LAPTOP_AI_TOKEN || undefined,
    aiAccessMode: env.AI_ACCESS_MODE === 'test' ? 'test' : env.AI_ACCESS_MODE === 'scoped' ? 'scoped' : env.AI_ACCESS_MODE === 'consented' ? 'consented' : 'off',
    aiAllowedSubjects,
    laptopAiModel: env.LAPTOP_AI_MODEL ?? 'qwen3.5:4b',
    laptopAiTimeoutMs: Number(env.LAPTOP_AI_TIMEOUT_MS ?? 25000),
    aiProvider: env.AI_PROVIDER === 'gemini' ? ('gemini' as const) : ('laptop' as const),
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiModel: env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    followupPipeline: env.FOLLOWUP_PIPELINE === 'true',
    mainAdminSubject: env.MAIN_ADMIN_SUBJECT?.trim() || undefined,
  } as Config;
}
