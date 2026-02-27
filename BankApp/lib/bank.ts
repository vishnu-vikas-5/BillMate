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

export type TransferResult = {
  ok: boolean;
  message: string;
  state: BankState;
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

async function saveCloudBankState(uid: string, state: BankState): Promise<boolean> {
  if (!firebaseConfigured || !db) {
    return false;
  }

  try {
    await setDoc(doc(db, 'users', uid), {
      bankState: state,
      bankUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return true;
  } catch {
    return false;
  }
}

async function getUidByAccountNumber(accountNumber: string): Promise<string | null> {
  if (!firebaseConfigured || !db) {
    return null;
  }

  try {
    const normalized = accountNumber.trim().toUpperCase();
    if (!normalized) {
      return null;
    }

    const snapshot = await getDoc(doc(db, 'bankAccounts', normalized));
    const uid = snapshot.data()?.uid;
    return typeof uid === 'string' && uid.trim() ? uid : null;
  } catch {
    return null;
  }
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

export async function transferToAccountByNumber(
  targetAccountNumber: string,
  amount: number,
  note = 'QR payment'
): Promise<TransferResult> {
  const senderUid = auth?.currentUser?.uid;
  if (!senderUid) {
    return {
      ok: false,
      message: 'You must be logged in to make payment.',
      state: defaultBankState,
    };
  }

  const normalizedTarget = targetAccountNumber.trim().toUpperCase();
  if (!/^BM[A-Z0-9]{6,}$/.test(normalizedTarget)) {
    const senderState = await getBankState();
    return {
      ok: false,
      message: 'Invalid receiver account number.',
      state: senderState,
    };
  }

  const senderAccountNumber = await ensureBankAccountForUser(senderUid);
  if (senderAccountNumber && senderAccountNumber.trim().toUpperCase() === normalizedTarget) {
    const senderState = await getBankState();
    return {
      ok: false,
      message: 'You cannot pay your own account.',
      state: senderState,
    };
  }

  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const senderState = await getBankState();
  if (safeAmount <= 0) {
    return {
      ok: false,
      message: 'Enter a valid amount.',
      state: senderState,
    };
  }

  if (senderState.balance < safeAmount) {
    return {
      ok: false,
      message: `Insufficient balance. Available: ${senderState.balance.toFixed(2)}`,
      state: senderState,
    };
  }

  const receiverUid = await getUidByAccountNumber(normalizedTarget);
  if (!receiverUid) {
    return {
      ok: false,
      message: 'Receiver account not found.',
      state: senderState,
    };
  }

  const receiverSnapshot = await getDoc(doc(db!, 'users', receiverUid));
  const receiverState = normalizeState(receiverSnapshot.data()?.bankState);

  const senderNextState: BankState = {
    balance: senderState.balance - safeAmount,
    transactions: [
      {
        id: `tx-${Date.now()}-debit`,
        type: 'debit',
        amount: safeAmount,
        note: `${note} to ${normalizedTarget}`,
        createdAt: new Date().toISOString(),
      },
      ...senderState.transactions,
    ],
  };

  const receiverNextState: BankState = {
    balance: receiverState.balance + safeAmount,
    transactions: [
      {
        id: `tx-${Date.now()}-credit`,
        type: 'credit',
        amount: safeAmount,
        note: `${note} from ${senderAccountNumber ?? senderUid}`,
        createdAt: new Date().toISOString(),
      },
      ...receiverState.transactions,
    ],
  };

  const senderSaved = await saveCloudBankState(senderUid, senderNextState);
  const receiverSaved = await saveCloudBankState(receiverUid, receiverNextState);

  await saveLocalBankState(senderUid, senderNextState);
  await saveLocalBankState(receiverUid, receiverNextState);

  if (!senderSaved || !receiverSaved) {
    return {
      ok: false,
      message: 'Payment partially saved locally. Cloud sync failed.',
      state: senderNextState,
    };
  }

  return {
    ok: true,
    message: `Payment successful: ${safeAmount.toFixed(2)} to ${normalizedTarget}`,
    state: senderNextState,
  };
}
