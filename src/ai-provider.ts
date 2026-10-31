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

export type AiProviderConfig = LaptopAiConfig & { geminiKey?: string; geminiModel?: string };
export { admitInference, admitReportCheck, admitStatus, LaptopAiError };
export type { Advisory, ChatReply, ContractorBrief, EmailDraft, LaptopAiConfig };

const g = (c: AiProviderConfig) => ({ apiKey: c.geminiKey, model: c.geminiModel ?? 'gemini-2.5-flash', timeoutMs: c.timeoutMs });

export const laptopAiStatus = (c: AiProviderConfig) => (c.geminiKey ? geminiStatus(g(c)) : laptopStatus(c));
export const reportCheck = (c: AiProviderConfig, i: { hazard: string; note?: string; lat: number; lon: number; ward?: string }): Promise<Advisory> =>
  (c.geminiKey ? geminiReportCheck(g(c), i) : laptopReportCheck(c, i));
export const chat = (c: AiProviderConfig, i: { message: string; context?: Record<string, unknown> | null }): Promise<ChatReply> =>
  (c.geminiKey ? geminiChat(g(c), i) : laptopChat(c, i));
export const imageCheck = (c: AiProviderConfig, i: { image_base64: string; hazard?: string; note?: string }): Promise<Advisory> =>
  (c.geminiKey ? geminiImageCheck(g(c), i) : laptopImageCheck(c, i));
export const emailDraft = (c: AiProviderConfig, i: { hazard: string; note?: string; lat: number; lon: number; ward?: string; complaint_no?: string }): Promise<EmailDraft> =>
  (c.geminiKey ? geminiEmailDraft(g(c), i) : laptopEmailDraft(c, i));
export const contractorBrief = (c: AiProviderConfig, rows: Record<string, unknown>[]): Promise<ContractorBrief> =>
  (c.geminiKey ? geminiContractorBrief(g(c), rows) : laptopContractorBrief(c, rows));
