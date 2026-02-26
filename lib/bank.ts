import AsyncStorage from '@react-native-async-storage/async-storage';

export type BankTransaction = {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  note: string;
  createdAt: string;
};

export type BankState = {
  balance: number;
  transactions: BankTransaction[];
};

const BANK_STORAGE_KEY = 'billmate:bank-state';

const defaultBankState: BankState = {
  balance: 0,
  transactions: [],
};

function normalizeState(value: unknown): BankState {
  if (!value || typeof value !== 'object') {
    return defaultBankState;
  }

  const candidate = value as Partial<BankState>;
  const balance = typeof candidate.balance === 'number' && Number.isFinite(candidate.balance)
    ? Math.max(0, candidate.balance)
    : 0;

  const transactions = Array.isArray(candidate.transactions)
    ? candidate.transactions
        .map((item): BankTransaction | null => {
          if (!item || typeof item !== 'object') {
            return null;
          }

          const tx = item as Partial<BankTransaction>;
          if (
            typeof tx.id !== 'string' ||
            (tx.type !== 'credit' && tx.type !== 'debit') ||
            typeof tx.amount !== 'number' ||
            !Number.isFinite(tx.amount) ||
            typeof tx.note !== 'string' ||
            typeof tx.createdAt !== 'string'
          ) {
            return null;
          }

          return {
            id: tx.id,
            type: tx.type,
            amount: tx.amount,
            note: tx.note,
            createdAt: tx.createdAt,
          };
        })
        .filter((item): item is BankTransaction => item !== null)
    : [];

  return { balance, transactions };
}

async function saveBankState(state: BankState): Promise<void> {
  await AsyncStorage.setItem(BANK_STORAGE_KEY, JSON.stringify(state));
}

export async function getBankState(): Promise<BankState> {
  try {
    const rawValue = await AsyncStorage.getItem(BANK_STORAGE_KEY);
    if (!rawValue) {
      return defaultBankState;
    }

    return normalizeState(JSON.parse(rawValue));
  } catch {
    return defaultBankState;
  }
}

export async function addVirtualMoney(amount: number, note = 'Added money'): Promise<BankState> {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  if (safeAmount <= 0) {
    return getBankState();
  }

  const previousState = await getBankState();
  const nextState: BankState = {
    balance: previousState.balance + safeAmount,
    transactions: [
      {
        id: `tx-${Date.now()}`,
        type: 'credit',
        amount: safeAmount,
        note,
        createdAt: new Date().toISOString(),
      },
      ...previousState.transactions,
    ],
  };

  await saveBankState(nextState);
  return nextState;
}

export async function tryDeductVirtualMoney(
  amount: number,
  note: string
): Promise<{ ok: boolean; state: BankState; message?: string }> {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const previousState = await getBankState();

  if (safeAmount <= 0) {
    return { ok: false, state: previousState, message: 'Invalid amount.' };
  }

  if (previousState.balance < safeAmount) {
    return {
      ok: false,
      state: previousState,
      message: `Insufficient balance. Available: ${previousState.balance.toFixed(2)}`,
    };
  }

  const nextState: BankState = {
    balance: previousState.balance - safeAmount,
    transactions: [
      {
        id: `tx-${Date.now()}`,
        type: 'debit',
        amount: safeAmount,
        note,
        createdAt: new Date().toISOString(),
      },
      ...previousState.transactions,
    ],
  };

  await saveBankState(nextState);
  return { ok: true, state: nextState };
}
