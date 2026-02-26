import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, getDoc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';

import { auth, db, firebaseConfigured } from './firebase';

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

export type AddVirtualMoneyResult = {
  state: BankState;
  persistedToCloud: boolean;
};

const LOCAL_BANK_KEY_PREFIX = 'bankapp:bank-state:';
const LOCAL_ACCOUNT_KEY_PREFIX = 'bankapp:account-number:';

const defaultBankState: BankState = {
  balance: 0,
  transactions: [],
};

function localBankKey(uid: string): string {
  return `${LOCAL_BANK_KEY_PREFIX}${uid}`;
}

function localAccountKey(uid: string): string {
  return `${LOCAL_ACCOUNT_KEY_PREFIX}${uid}`;
}

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

function generateAccountNumber(): string {
  const nowPart = Date.now().toString().slice(-6);
  const randomPart = Math.floor(1000 + Math.random() * 9000).toString();
  return `BM${nowPart}${randomPart}`;
}

async function getLocalBankState(uid: string): Promise<BankState> {
  try {
    const rawValue = await AsyncStorage.getItem(localBankKey(uid));
    if (!rawValue) {
      return defaultBankState;
    }

    return normalizeState(JSON.parse(rawValue));
  } catch {
    return defaultBankState;
  }
}

async function saveLocalBankState(uid: string, state: BankState): Promise<void> {
  await AsyncStorage.setItem(localBankKey(uid), JSON.stringify(state));
}

async function syncAccountNumberToCloud(uid: string, accountNumber: string): Promise<void> {
  if (!firebaseConfigured || !db) {
    return;
  }

  const firestore = db;
  const normalized = accountNumber.trim().toUpperCase();
  if (!normalized) {
    return;
  }

  const mappingRef = doc(firestore, 'bankAccounts', normalized);
  const mappingSnapshot = await getDoc(mappingRef);
  const mappedUid = mappingSnapshot.data()?.uid;

  if (typeof mappedUid === 'string' && mappedUid.trim() && mappedUid !== uid) {
    return;
  }

  await setDoc(mappingRef, {
    uid,
    updatedAt: serverTimestamp(),
    createdAt: mappingSnapshot.exists() ? mappingSnapshot.data()?.createdAt ?? serverTimestamp() : serverTimestamp(),
  }, { merge: true });

  await setDoc(doc(firestore, 'users', uid), {
    accountNumber: normalized,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function ensureBankAccountForUser(uid: string): Promise<string | null> {
  if (!uid) {
    return null;
  }

  const localStored = await AsyncStorage.getItem(localAccountKey(uid));
  if (localStored) {
    await syncAccountNumberToCloud(uid, localStored);
    return localStored;
  }

  if (!firebaseConfigured || !db) {
    const localAccount = generateAccountNumber();
    await AsyncStorage.setItem(localAccountKey(uid), localAccount);
    return localAccount;
  }

  const firestore = db;

  const userRef = doc(firestore, 'users', uid);

  try {
    const userSnapshot = await getDoc(userRef);
    const existingAccount = userSnapshot.data()?.accountNumber;
    if (typeof existingAccount === 'string' && existingAccount.trim()) {
      await AsyncStorage.setItem(localAccountKey(uid), existingAccount);
      await syncAccountNumberToCloud(uid, existingAccount);
      return existingAccount;
    }
  } catch {
    const fallback = generateAccountNumber();
    await AsyncStorage.setItem(localAccountKey(uid), fallback);
    return fallback;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateAccountNumber();
    try {
      const accountNumber = await runTransaction(firestore, async (transaction) => {
        const latestUser = await transaction.get(userRef);
        const latestExisting = latestUser.data()?.accountNumber;

        if (typeof latestExisting === 'string' && latestExisting.trim()) {
          return latestExisting;
        }

        const mappingRef = doc(firestore, 'bankAccounts', candidate);
        const mappingSnapshot = await transaction.get(mappingRef);
        if (mappingSnapshot.exists()) {
          throw new Error('bank-account-conflict');
        }

        transaction.set(mappingRef, {
          uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        transaction.set(userRef, {
          accountNumber: candidate,
          bankState: defaultBankState,
          bankCreatedAt: serverTimestamp(),
          bankUpdatedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: true });

        return candidate;
      });

      await AsyncStorage.setItem(localAccountKey(uid), accountNumber);
      return accountNumber;
    } catch (error) {
      if (error instanceof Error && error.message === 'bank-account-conflict') {
        continue;
      }

      const fallback = generateAccountNumber();
      await AsyncStorage.setItem(localAccountKey(uid), fallback);
      return fallback;
    }
  }

  const fallback = generateAccountNumber();
  await AsyncStorage.setItem(localAccountKey(uid), fallback);
  return fallback;
}

export async function getBankState(): Promise<BankState> {
  const uid = auth?.currentUser?.uid;
  if (!uid) {
    return defaultBankState;
  }

  if (!firebaseConfigured || !db) {
    return getLocalBankState(uid);
  }

  try {
    const userRef = doc(db, 'users', uid);
    const userSnapshot = await getDoc(userRef);

    if (userSnapshot.exists()) {
      const userData = userSnapshot.data();
      const normalizedUserBankState = normalizeState(userData.bankState);
      const hasUserBankState =
        typeof userData.bankState === 'object' &&
        userData.bankState !== null &&
        Array.isArray((userData.bankState as { transactions?: unknown }).transactions);

      if (hasUserBankState) {
        await saveLocalBankState(uid, normalizedUserBankState);
        return normalizedUserBankState;
      }
    }

    const legacyBankRef = doc(db, 'users', uid, 'bank', 'state');
    const legacyBankSnapshot = await getDoc(legacyBankRef);
    if (legacyBankSnapshot.exists()) {
      const legacyState = normalizeState(legacyBankSnapshot.data());
      await setDoc(userRef, {
        bankState: legacyState,
        bankUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      await saveLocalBankState(uid, legacyState);
      return legacyState;
    }

    await setDoc(userRef, {
      bankState: defaultBankState,
      bankCreatedAt: serverTimestamp(),
      bankUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return defaultBankState;
  } catch {
    return getLocalBankState(uid);
  }
}

export async function addVirtualMoney(amount: number, note = 'Added money'): Promise<AddVirtualMoneyResult> {
  const uid = auth?.currentUser?.uid;
  if (!uid) {
    throw new Error('You must be logged in to add money.');
  }

  const safeAmount = Number.isFinite(amount) ? amount : 0;
  if (safeAmount <= 0) {
    const currentState = await getBankState();
    return {
      state: currentState,
      persistedToCloud: firebaseConfigured && !!db,
    };
  }

  await ensureBankAccountForUser(uid);
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

  if (firebaseConfigured && db) {
    try {
      await setDoc(doc(db, 'users', uid), {
        bankState: nextState,
        bankUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      await saveLocalBankState(uid, nextState);
      return {
        state: nextState,
        persistedToCloud: true,
      };
    } catch {
      await saveLocalBankState(uid, nextState);
      return {
        state: nextState,
        persistedToCloud: false,
      };
    }
  }

  await saveLocalBankState(uid, nextState);
  return {
    state: nextState,
    persistedToCloud: false,
  };
}
