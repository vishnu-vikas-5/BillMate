import { getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const BANK_FIREBASE_APP_NAME = 'bank-app';

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_BANK_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_BANK_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_BANK_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_BANK_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_BANK_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_BANK_FIREBASE_APP_ID,
};

const requiredFirebaseKeys = [
  'EXPO_PUBLIC_BANK_FIREBASE_API_KEY',
  'EXPO_PUBLIC_BANK_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_BANK_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_BANK_FIREBASE_APP_ID',
] as const;

export const missingFirebaseEnvKeys = requiredFirebaseKeys.filter((key) => !process.env[key]);
export const firebaseConfigured = missingFirebaseEnvKeys.length === 0;

const existingBankApp = getApps().find((app) => app.name === BANK_FIREBASE_APP_NAME);
const app = firebaseConfigured
  ? existingBankApp ?? initializeApp(firebaseConfig, BANK_FIREBASE_APP_NAME)
  : null;

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
