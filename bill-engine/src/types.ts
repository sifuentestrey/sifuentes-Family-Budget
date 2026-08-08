export type BillSource = 'email' | 'provider_api' | 'provider_portal' | 'manual';

export type BillStatus = 'estimated' | 'confirmed' | 'paid' | 'overdue';

export type Bill = {
  id: string;
  providerId: string;
  providerName: string;
  category: string;
  source: BillSource;
  accountLabel?: string;
  amountDue: number;
  dueDate?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  status: BillStatus;
  currency: 'USD';
  confidence: number;
  externalId?: string;
  sourceMessageId?: string;
  sourceUrl?: string;
  fetchedAt: string;
  rawReference?: string;
};

export type BillCandidate = Omit<Bill, 'id' | 'status' | 'fetchedAt'> & {
  status?: BillStatus;
  fetchedAt?: string;
};

export type BillExtraction = {
  providerName?: string;
  amountDue?: number;
  dueDate?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  accountLabel?: string;
  externalId?: string;
  confidence: number;
  matchedFields: string[];
};

export type BillProvider = {
  id: string;
  name: string;
  categories: string[];
  emailDomains?: string[];
  senderAddresses?: string[];
};
