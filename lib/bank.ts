import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    doc,
    getDoc,
    runTransaction,
    serverTimestamp,
    setDoc,
    type DocumentData,
} from 'firebase/firestore';

import { auth, db, firebaseConfigured } from '@/lib/firebase';

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

export type LinkedBankAccountInfo = {
  ownAccountNumber: string | null;
  linkedAccountNumber: string | null;
  linkedAccountOwnerUid: string | null;
};

type BankOwnerContext = {
  cloudOwnerUid: string | null;
  localOwnerKey: string;
};

const LOCAL_BANK_STORAGE_KEY_PREFIX = 'billmate:bank-state:';
const LINKED_ACCOUNT_KEY_PREFIX = 'billmate:linked-bank-account:';
const LOCAL_ACCOUNT_KEY_PREFIX = 'billmate:bank-account-number:';
const LOCAL_ACCOUNT_UID_MAP_KEY = 'billmate:bank-account-uid-map';

const defaultBankState: BankState = {
  balance: 0,
  transactions: [],
};

function linkedAccountStorageKey(uid: string): string {
  return `${LINKED_ACCOUNT_KEY_PREFIX}${uid}`;
}

function localAccountStorageKey(uid: string): string {
  return `${LOCAL_ACCOUNT_KEY_PREFIX}${uid}`;
}

function localBankStorageKey(ownerKey: string): string {
  return `${LOCAL_BANK_STORAGE_KEY_PREFIX}${ownerKey}`;
}

function normalizeAccountNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function isValidAccountNumber(value: string): boolean {
  return /^BM[A-Z0-9]{6,}$/.test(value);
}

function generateAccountNumber(): string {
  const nowPart = Date.now().toString().slice(-6);
  const randomPart = Math.floor(1000 + Math.random() * 9000).toString();
  return `BM${nowPart}${randomPart}`;
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

async function saveBankState(state: BankState): Promise<void> {
  await AsyncStorage.setItem(localBankStorageKey('guest'), JSON.stringify(state));
}

async function saveLocalBankState(ownerKey: string, state: BankState): Promise<void> {
  await AsyncStorage.setItem(localBankStorageKey(ownerKey), JSON.stringify(state));
}

async function getLocalUidMap(): Promise<Record<string, string>> {
  try {
    const rawValue = await AsyncStorage.getItem(LOCAL_ACCOUNT_UID_MAP_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const map = parsed as Record<string, unknown>;
    return Object.entries(map).reduce<Record<string, string>>((result, [key, value]) => {
      if (typeof value === 'string' && value.trim()) {
        result[normalizeAccountNumber(key)] = value;
      }
      return result;
    }, {});
  } catch {
    return {};
  }
}

async function saveLocalUidMap(map: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(LOCAL_ACCOUNT_UID_MAP_KEY, JSON.stringify(map));
}

async function registerLocalAccountMapping(accountNumber: string, uid: string): Promise<void> {
  const normalized = normalizeAccountNumber(accountNumber);
  if (!normalized || !uid) {
    return;
  }

  await AsyncStorage.setItem(localAccountStorageKey(uid), normalized);
  const map = await getLocalUidMap();
  map[normalized] = uid;
  await saveLocalUidMap(map);
}

async function getLocalUidByAccountNumber(accountNumber: string): Promise<string | null> {
  const normalized = normalizeAccountNumber(accountNumber);
  if (!normalized) {
    return null;
  }

  const map = await getLocalUidMap();
  return map[normalized] ?? null;
}

async function getOrCreateLocalAccountNumber(uid: string): Promise<string> {
  const stored = await AsyncStorage.getItem(localAccountStorageKey(uid));
  if (stored) {
    const normalizedStored = normalizeAccountNumber(stored);
    await registerLocalAccountMapping(normalizedStored, uid);
    return normalizedStored;
  }

  const uidMap = await getLocalUidMap();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateAccountNumber();
    if (!uidMap[candidate]) {
      uidMap[candidate] = uid;
      await AsyncStorage.setItem(localAccountStorageKey(uid), candidate);
      await saveLocalUidMap(uidMap);
      return candidate;
    }
  }

  const fallback = `BM${uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase()}`;
  uidMap[fallback] = uid;
  await AsyncStorage.setItem(localAccountStorageKey(uid), fallback);
  await saveLocalUidMap(uidMap);
  return fallback;
}

async function saveCloudBankState(ownerUid: string, state: BankState): Promise<void> {
  await setDoc(
    doc(db, 'users', ownerUid),
    {
      bankState: state,
      updatedAt: serverTimestamp(),
      bankUpdatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function persistStateForOwner(ownerContext: BankOwnerContext, state: BankState): Promise<void> {
  if (ownerContext.cloudOwnerUid) {
    try {
      await saveCloudBankState(ownerContext.cloudOwnerUid, state);
      return;
    } catch {
      await saveLocalBankState(ownerContext.localOwnerKey, state);
      return;
    }
  }

  await saveLocalBankState(ownerContext.localOwnerKey, state);
}

async function getUidByAccountNumber(accountNumber: string): Promise<string | null> {
  const normalized = normalizeAccountNumber(accountNumber);
  if (!normalized || !isValidAccountNumber(normalized)) {
    return null;
  }

  if (firebaseConfigured) {
    try {
      const mappingSnapshot = await getDoc(doc(db, 'bankAccounts', normalized));
      if (mappingSnapshot.exists()) {
        const mappingData = mappingSnapshot.data() as DocumentData;
        if (typeof mappingData.uid === 'string') {
          await registerLocalAccountMapping(normalized, mappingData.uid);
          return mappingData.uid;
        }
      }
    } catch {
      // Fall back to local mapping.
    }
  }

  return getLocalUidByAccountNumber(normalized);
}

async function ensureCloudBankDoc(ownerUid: string): Promise<BankState> {
  const userRef = doc(db, 'users', ownerUid);
  const userSnapshot = await getDoc(userRef);

  if (userSnapshot.exists()) {
    const userData = userSnapshot.data() as DocumentData;
    const normalizedUserBankState = normalizeState(userData.bankState);
    const hasUserBankState =
      typeof userData.bankState === 'object' &&
      userData.bankState !== null &&
      Array.isArray((userData.bankState as Record<string, unknown>).transactions);

    if (hasUserBankState) {
      return normalizedUserBankState;
    }
  }

  const legacyBankRef = doc(db, 'users', ownerUid, 'bank', 'state');
  const legacyBankSnapshot = await getDoc(legacyBankRef);
  if (legacyBankSnapshot.exists()) {
    const legacyState = normalizeState(legacyBankSnapshot.data());
    await saveCloudBankState(ownerUid, legacyState);
    return legacyState;
  }

  await setDoc(
    userRef,
    {
      bankState: defaultBankState,
      bankCreatedAt: serverTimestamp(),
      bankUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return defaultBankState;
}

async function getLocalBankState(ownerKey = 'guest'): Promise<BankState> {
  try {
    const rawValue = await AsyncStorage.getItem(localBankStorageKey(ownerKey));
    if (!rawValue) {
      return defaultBankState;
    }

    return normalizeState(JSON.parse(rawValue));
  } catch {
    return defaultBankState;
  }
}

export async function ensureBankAccountForUser(uid: string): Promise<string | null> {
  if (!uid) {
    return null;
  }

  const existingLocalAccount = await AsyncStorage.getItem(localAccountStorageKey(uid));
  if (existingLocalAccount) {
    const normalizedLocal = normalizeAccountNumber(existingLocalAccount);
    await registerLocalAccountMapping(normalizedLocal, uid);
    return normalizedLocal;
  }

  if (!firebaseConfigured) {
    return getOrCreateLocalAccountNumber(uid);
  }

  const userRef = doc(db, 'users', uid);
  try {
    const userSnapshot = await getDoc(userRef);
    const existingAccountNumber = userSnapshot.data()?.accountNumber;
    if (typeof existingAccountNumber === 'string' && existingAccountNumber.trim()) {
      const normalizedExisting = normalizeAccountNumber(existingAccountNumber);
      await registerLocalAccountMapping(normalizedExisting, uid);
      return normalizedExisting;
    }
  } catch {
    return getOrCreateLocalAccountNumber(uid);
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateAccountNumber();

    try {
      const accountNumber = await runTransaction(db, async (transaction) => {
        const latestUser = await transaction.get(userRef);
        const latestExisting = latestUser.data()?.accountNumber;
        if (typeof latestExisting === 'string' && latestExisting.trim()) {
          return normalizeAccountNumber(latestExisting);
        }

        const mappingRef = doc(db, 'bankAccounts', candidate);
        const mappingSnapshot = await transaction.get(mappingRef);
        if (mappingSnapshot.exists()) {
          throw new Error('bank-account-conflict');
        }

        transaction.set(mappingRef, {
          uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        transaction.set(
          userRef,
          {
            accountNumber: candidate,
            bankState: defaultBankState,
            bankCreatedAt: serverTimestamp(),
            bankUpdatedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        return candidate;
      });

      await registerLocalAccountMapping(accountNumber, uid);
      return accountNumber;
    } catch (error) {
      if (error instanceof Error && error.message === 'bank-account-conflict') {
        continue;
      }
      return getOrCreateLocalAccountNumber(uid);
    }
  }

  return getOrCreateLocalAccountNumber(uid);
}

export async function ensureBankAccountForCurrentUser(): Promise<string | null> {
  const currentUid = auth?.currentUser?.uid;
  if (!currentUid) {
    return null;
  }

  return ensureBankAccountForUser(currentUid);
}

async function resolveBankOwnerContext(): Promise<BankOwnerContext> {
  const currentUid = auth?.currentUser?.uid;
  if (!currentUid) {
    return {
      cloudOwnerUid: null,
      localOwnerKey: 'guest',
    };
  }

  const ownAccountNumber = await ensureBankAccountForUser(currentUid);

  const linkedAccountNumber = await AsyncStorage.getItem(linkedAccountStorageKey(currentUid));
  if (linkedAccountNumber) {
    const linkedUid = await getUidByAccountNumber(linkedAccountNumber);
    if (linkedUid) {
      return {
        cloudOwnerUid: firebaseConfigured ? linkedUid : null,
        localOwnerKey: `acc:${normalizeAccountNumber(linkedAccountNumber)}`,
      };
    }

    await AsyncStorage.removeItem(linkedAccountStorageKey(currentUid));
  }

  return {
    cloudOwnerUid: firebaseConfigured ? currentUid : null,
    localOwnerKey: ownAccountNumber ? `acc:${ownAccountNumber}` : `uid:${currentUid}`,
  };
}

export async function getLinkedBankAccountInfo(): Promise<LinkedBankAccountInfo> {
  const currentUid = auth?.currentUser?.uid;
  if (!currentUid) {
    return {
      ownAccountNumber: null,
      linkedAccountNumber: null,
      linkedAccountOwnerUid: null,
    };
  }

  const ownAccountNumber = await ensureBankAccountForUser(currentUid);
  const linkedAccountNumber = await AsyncStorage.getItem(linkedAccountStorageKey(currentUid));

  if (!linkedAccountNumber) {
    return {
      ownAccountNumber,
      linkedAccountNumber: null,
      linkedAccountOwnerUid: null,
    };
  }

  const linkedAccountOwnerUid = await getUidByAccountNumber(linkedAccountNumber);
  if (!linkedAccountOwnerUid) {
    await AsyncStorage.removeItem(linkedAccountStorageKey(currentUid));
    return {
      ownAccountNumber,
      linkedAccountNumber: null,
      linkedAccountOwnerUid: null,
    };
  }

  return {
    ownAccountNumber,
    linkedAccountNumber,
    linkedAccountOwnerUid,
  };
}

export async function linkBankAccountByNumber(
  accountNumber: string
): Promise<{ ok: boolean; message: string; info: LinkedBankAccountInfo }> {
  const normalized = normalizeAccountNumber(accountNumber);

  if (!normalized || !isValidAccountNumber(normalized)) {
    return {
      ok: false,
      message: 'Enter a valid account number (example: BM12345678).',
      info: await getLinkedBankAccountInfo(),
    };
  }

  const currentUid = auth?.currentUser?.uid;
  if (!currentUid) {
    return {
      ok: false,
      message: 'Login required to link account.',
      info: await getLinkedBankAccountInfo(),
    };
  }

  const ownerUid = await getUidByAccountNumber(normalized);
  if (!ownerUid) {
    return {
      ok: false,
      message: 'Account number not found.',
      info: await getLinkedBankAccountInfo(),
    };
  }

  await AsyncStorage.setItem(linkedAccountStorageKey(currentUid), normalized);
  return {
    ok: true,
    message: ownerUid === currentUid ? 'Linked to your own bank account.' : 'Linked successfully.',
    info: await getLinkedBankAccountInfo(),
  };
}

export async function unlinkLinkedBankAccount(): Promise<LinkedBankAccountInfo> {
  const currentUid = auth?.currentUser?.uid;
  if (currentUid) {
    await AsyncStorage.removeItem(linkedAccountStorageKey(currentUid));
  }

  return getLinkedBankAccountInfo();
}

export async function getBankState(): Promise<BankState> {
  try {
    const ownerContext = await resolveBankOwnerContext();
    if (ownerContext.cloudOwnerUid) {
      return await ensureCloudBankDoc(ownerContext.cloudOwnerUid);
    }

    return await getLocalBankState(ownerContext.localOwnerKey);
  } catch {
    return getLocalBankState('guest');
  }
}

export async function addVirtualMoney(amount: number, note = 'Added money'): Promise<BankState> {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  if (safeAmount <= 0) {
    return getBankState();
  }

  const ownerContext = await resolveBankOwnerContext();
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

  if (ownerContext.cloudOwnerUid) {
    try {
      await saveCloudBankState(ownerContext.cloudOwnerUid, nextState);
      return nextState;
    } catch {
      await saveLocalBankState(ownerContext.localOwnerKey, nextState);
      return nextState;
    }
  }

  await saveLocalBankState(ownerContext.localOwnerKey, nextState);
  return nextState;
}

export async function tryDeductVirtualMoney(
  amount: number,
  note: string
): Promise<{ ok: boolean; state: BankState; message?: string }> {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const ownerContext = await resolveBankOwnerContext();
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

  if (ownerContext.cloudOwnerUid) {
    try {
      await saveCloudBankState(ownerContext.cloudOwnerUid, nextState);
      return { ok: true, state: nextState };
    } catch {
      await saveLocalBankState(ownerContext.localOwnerKey, nextState);
      return { ok: true, state: nextState };
    }
  }

  await saveLocalBankState(ownerContext.localOwnerKey, nextState);
  return { ok: true, state: nextState };
}

export async function payToAccountByNumber(
  accountNumber: string,
  amount: number,
  note = 'QR payment'
): Promise<{ ok: boolean; state: BankState; message: string }> {
  const currentUid = auth?.currentUser?.uid;
  const payerState = await getBankState();

  if (!currentUid) {
    return { ok: false, state: payerState, message: 'Login required to make payment.' };
  }

  const normalizedAccountNumber = normalizeAccountNumber(accountNumber);
  if (!normalizedAccountNumber || !isValidAccountNumber(normalizedAccountNumber)) {
    return { ok: false, state: payerState, message: 'Invalid receiver account number.' };
  }

  const safeAmount = Number.isFinite(amount) ? amount : 0;
  if (safeAmount <= 0) {
    return { ok: false, state: payerState, message: 'Invalid amount.' };
  }

  const ownAccountNumber = await ensureBankAccountForUser(currentUid);
  if (ownAccountNumber && normalizeAccountNumber(ownAccountNumber) === normalizedAccountNumber) {
    return { ok: false, state: payerState, message: 'You cannot pay your own account.' };
  }

  if (payerState.balance < safeAmount) {
    return {
      ok: false,
      state: payerState,
      message: `Insufficient balance. Available: ${payerState.balance.toFixed(2)}`,
    };
  }

  const recipientUid = await getUidByAccountNumber(normalizedAccountNumber);
  if (!recipientUid) {
    return { ok: false, state: payerState, message: 'Receiver account not found.' };
  }

  const payerOwnerContext = await resolveBankOwnerContext();
  const payerNextState: BankState = {
    balance: payerState.balance - safeAmount,
    transactions: [
      {
        id: `tx-${Date.now()}-debit`,
        type: 'debit',
        amount: safeAmount,
        note: `${note} to ${normalizedAccountNumber}`,
        createdAt: new Date().toISOString(),
      },
      ...payerState.transactions,
    ],
  };

  const recipientOwnerContext: BankOwnerContext = {
    cloudOwnerUid: firebaseConfigured ? recipientUid : null,
    localOwnerKey: `acc:${normalizedAccountNumber}`,
  };

  const recipientPreviousState = recipientOwnerContext.cloudOwnerUid
    ? await ensureCloudBankDoc(recipientUid)
    : await getLocalBankState(recipientOwnerContext.localOwnerKey);

  const recipientNextState: BankState = {
    balance: recipientPreviousState.balance + safeAmount,
    transactions: [
      {
        id: `tx-${Date.now()}-credit`,
        type: 'credit',
        amount: safeAmount,
        note: `${note} from ${ownAccountNumber ?? currentUid}`,
        createdAt: new Date().toISOString(),
      },
      ...recipientPreviousState.transactions,
    ],
  };

  await persistStateForOwner(payerOwnerContext, payerNextState);
  await persistStateForOwner(recipientOwnerContext, recipientNextState);

  return {
    ok: true,
    state: payerNextState,
    message: `Paid ${safeAmount.toFixed(2)} to ${normalizedAccountNumber}`,
  };
}
