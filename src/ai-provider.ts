/**
 * Provider switch for the assistant routes: Gemini (GEMINI_API_KEY set) or the
 * operator laptop gateway. Same function surface as laptop-ai.ts - app.ts
 * imports from here so the choice is config-driven, not code-driven.
 */
import {
  admitInference,
  admitReportCheck,
  admitStatus,
  chat as laptopChat,
  contractorBrief as laptopContractorBrief,
  emailDraft as laptopEmailDraft,
  imageCheck as laptopImageCheck,
  laptopAiStatus as laptopStatus,
  reportCheck as laptopReportCheck,
  LaptopAiError,
  type Advisory,
  type ChatReply,
  type ContractorBrief,
  type EmailDraft,
  type LaptopAiConfig,
} from './laptop-ai.ts';
import {
  chat as geminiChat,
  contractorBrief as geminiContractorBrief,
  emailDraft as geminiEmailDraft,
  geminiStatus,
  imageCheck as geminiImageCheck,
  reportCheck as geminiReportCheck,
} from './gemini-ai.ts';

export type AiProviderConfig = LaptopAiConfig & { provider: 'laptop' | 'gemini'; geminiKey?: string; geminiModel?: string };
export { admitInference, admitReportCheck, admitStatus, LaptopAiError };
export type { Advisory, ChatReply, ContractorBrief, EmailDraft, LaptopAiConfig };

// Provider is chosen ONLY by the explicit AI_PROVIDER setting. A key sitting in
// the env (e.g. parked early) must never by itself reroute user data to Google:
// provider 'laptop' + a set GEMINI_API_KEY still uses the laptop path.
const useGemini = (c: AiProviderConfig) => c.provider === 'gemini';
const g = (c: AiProviderConfig) => ({ apiKey: c.geminiKey, model: c.geminiModel ?? 'gemini-2.5-flash', timeoutMs: c.timeoutMs });

export const laptopAiStatus = (c: AiProviderConfig) => (useGemini(c) ? geminiStatus(g(c)) : laptopStatus(c));
export const reportCheck = (c: AiProviderConfig, i: { hazard: string; note?: string; lat: number; lon: number; ward?: string }): Promise<Advisory> =>
  (useGemini(c) ? geminiReportCheck(g(c), i) : laptopReportCheck(c, i));
export const chat = (c: AiProviderConfig, i: { message: string; context?: Record<string, unknown> | null }): Promise<ChatReply> =>
  (useGemini(c) ? geminiChat(g(c), i) : laptopChat(c, i));
export const imageCheck = (c: AiProviderConfig, i: { image_base64: string; hazard?: string; note?: string }): Promise<Advisory> =>
  (useGemini(c) ? geminiImageCheck(g(c), i) : laptopImageCheck(c, i));
export const emailDraft = (c: AiProviderConfig, i: { hazard: string; note?: string; lat: number; lon: number; ward?: string; complaint_no?: string }): Promise<EmailDraft> =>
  (useGemini(c) ? geminiEmailDraft(g(c), i) : laptopEmailDraft(c, i));
export const contractorBrief = (c: AiProviderConfig, rows: Record<string, unknown>[]): Promise<ContractorBrief> =>
  (useGemini(c) ? geminiContractorBrief(g(c), rows) : laptopContractorBrief(c, rows));
