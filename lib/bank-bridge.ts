import { FirebaseError, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    limit,
    query,
    where,
    type Firestore,
} from 'firebase/firestore';

type LinkedBalanceResult = {
  balance: number | null;
  message?: string;
};

const BANK_BRIDGE_APP_NAME = 'billmate-bank-bridge';

const bankFirebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_BANK_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_BANK_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_BANK_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_BANK_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_BANK_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_BANK_FIREBASE_APP_ID,
};

const requiredBankKeys = [
  'EXPO_PUBLIC_BANK_FIREBASE_API_KEY',
  'EXPO_PUBLIC_BANK_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_BANK_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_BANK_FIREBASE_APP_ID',
] as const;

function normalizeAccountNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function isValidAccountNumber(value: string): boolean {
  return /^BM[A-Z0-9]{6,}$/.test(value);
}

function getMissingBankKeys(): string[] {
  return requiredBankKeys.filter((key) => !process.env[key]);
}

function getBankBridgeDb(): { db: Firestore | null; message?: string } {
  const missingKeys = getMissingBankKeys();
  if (missingKeys.length > 0) {
    return {
      db: null,
      message: `Bank Firebase config missing in BillMate: ${missingKeys.join(', ')}`,
    };
  }

  const existingApp = getApps().find((app) => app.name === BANK_BRIDGE_APP_NAME);
  const app: FirebaseApp = existingApp ?? initializeApp(bankFirebaseConfig, BANK_BRIDGE_APP_NAME);
  return { db: getFirestore(app) };
}

export async function getLinkedBankBalanceByAccountNumber(accountNumber: string): Promise<LinkedBalanceResult> {
  const normalized = normalizeAccountNumber(accountNumber);
  if (!normalized || !isValidAccountNumber(normalized)) {
    return { balance: null, message: 'Invalid account number format.' };
  }

  const { db, message } = getBankBridgeDb();
  if (!db) {
    return { balance: null, message };
  }

  try {
    const mappingSnapshot = await getDoc(doc(db, 'bankAccounts', normalized));
    let ownerUid: string | null = null;

    if (mappingSnapshot.exists()) {
      const mappedUid = mappingSnapshot.data()?.uid;
      ownerUid = typeof mappedUid === 'string' && mappedUid.trim() ? mappedUid : null;
    }

    if (!ownerUid) {
      const usersQuery = query(
        collection(db, 'users'),
        where('accountNumber', '==', normalized),
        limit(1)
      );
      const usersSnapshot = await getDocs(usersQuery);
      if (!usersSnapshot.empty) {
        ownerUid = usersSnapshot.docs[0].id;
      }
    }

    if (typeof ownerUid !== 'string' || !ownerUid.trim()) {
      return {
        balance: null,
        message: 'Linked account not found in Bank database. Open Bank app once and ensure account is created.',
      };
    }

    const userSnapshot = await getDoc(doc(db, 'users', ownerUid));
    if (userSnapshot.exists()) {
      const bankState = userSnapshot.data()?.bankState;
      const balance = bankState?.balance;
      if (typeof balance === 'number' && Number.isFinite(balance)) {
        return { balance };
      }
    }

    const legacyBankSnapshot = await getDoc(doc(db, 'users', ownerUid, 'bank', 'state'));
    if (!legacyBankSnapshot.exists()) {
      return { balance: 0 };
    }

    const legacyBalance = legacyBankSnapshot.data()?.balance;
    if (typeof legacyBalance === 'number' && Number.isFinite(legacyBalance)) {
      return { balance: legacyBalance };
    }

    return { balance: 0 };
  } catch (error) {
    if (error instanceof FirebaseError && error.code.includes('permission-denied')) {
      return {
        balance: null,
        message: 'Cannot read Bank balance due to Bank Firestore rules.',
      };
    }

    return {
      balance: null,
      message: 'Unable to load linked bank balance right now.',
    };
  }
}
