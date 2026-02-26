import { StatusBar } from 'expo-status-bar';
import {
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut,
    updateProfile,
    type AuthError,
    type User,
} from 'firebase/auth';
import { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';

import {
    addVirtualMoney,
    ensureBankAccountForUser,
    getBankState,
    type BankState,
} from './lib/bank';
import { auth, firebaseConfigured, missingFirebaseEnvKeys } from './lib/firebase';

type AuthMode = 'login' | 'signup';

function getAuthErrorMessage(error: unknown): string {
  const code = (error as AuthError | undefined)?.code;

  switch (code) {
    case 'auth/invalid-api-key':
      return 'Invalid Firebase API key for BankApp. Check EXPO_PUBLIC_BANK_FIREBASE_API_KEY.';
    case 'auth/configuration-not-found':
      return 'Authentication provider is not configured in Bank Firebase project.';
    case 'auth/operation-not-allowed':
      return 'Email/Password sign-in is disabled in Bank Firebase Authentication.';
    case 'auth/network-request-failed':
      return 'Network error. Check your internet and try again.';
    case 'auth/user-not-found':
      return 'No BankApp account found for this email. Create account first.';
    case 'auth/wrong-password':
    case 'auth/invalid-login-credentials':
      return 'Incorrect email or password.';
    case 'auth/email-already-in-use':
      return 'Email already exists. Try Login instead of Sign Up.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 6 characters.';
    case 'auth/invalid-email':
      return 'Invalid email format.';
    default:
      return error instanceof Error ? error.message : 'Authentication failed.';
  }
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [bankState, setBankState] = useState<BankState | null>(null);
  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [bankLoading, setBankLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const loadBank = async () => {
      if (!currentUser) {
        setBankState(null);
        setAccountNumber(null);
        return;
      }

      setBankLoading(true);
      try {
        const [acc, state] = await Promise.all([
          ensureBankAccountForUser(currentUser.uid),
          getBankState(),
        ]);
        setAccountNumber(acc);
        setBankState(state);
      } finally {
        setBankLoading(false);
      }
    };

    void loadBank();
  }, [currentUser]);

  const authDisabled = useMemo(() => authLoading, [authLoading]);

  const onEmailAuth = async () => {
    setStatus(null);

    if (!firebaseConfigured || !auth) {
      setStatus({ type: 'error', message: `Missing Firebase env: ${missingFirebaseEnvKeys.join(', ')}` });
      return;
    }

    if (!email.trim() || !password.trim()) {
      setStatus({ type: 'error', message: 'Enter email and password.' });
      return;
    }

    try {
      setAuthLoading(true);

      if (authMode === 'signup') {
        if (!name.trim()) {
          setStatus({ type: 'error', message: 'Enter your name.' });
          return;
        }

        if (password !== confirmPassword) {
          setStatus({ type: 'error', message: 'Passwords do not match.' });
          return;
        }

        const created = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(created.user, { displayName: name.trim() });
        await ensureBankAccountForUser(created.user.uid);
        setStatus({ type: 'success', message: 'Account created and bank initialized.' });
      } else {
        const signedIn = await signInWithEmailAndPassword(auth, email.trim(), password);
        await ensureBankAccountForUser(signedIn.user.uid);
        setStatus({ type: 'success', message: 'Logged in successfully.' });
      }
    } catch (error) {
      setStatus({ type: 'error', message: getAuthErrorMessage(error) });
    } finally {
      setAuthLoading(false);
    }
  };

  const onLogout = async () => {
    setStatus(null);
    if (!auth) {
      setStatus({ type: 'error', message: 'Firebase is not configured.' });
      return;
    }

    try {
      setAuthLoading(true);
      await signOut(auth);
      setStatus({ type: 'success', message: 'Logged out.' });
    } catch {
      setStatus({ type: 'error', message: 'Logout failed.' });
    } finally {
      setAuthLoading(false);
    }
  };

  const onAddMoney = async () => {
    setStatus(null);
    const normalizedAmountInput = amountInput.trim().replace(/,/g, '.');
    const amount = Number.parseFloat(normalizedAmountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus({ type: 'error', message: 'Enter a valid amount.' });
      return;
    }

    setBankLoading(true);
    try {
      const result = await addVirtualMoney(amount, 'Manual top-up');
      setBankState(result.state);
      setAmountInput('');
      setStatus({
        type: result.persistedToCloud ? 'success' : 'error',
        message: result.persistedToCloud
          ? `Money added. Balance: ${result.state.balance.toFixed(2)}`
          : `Money added locally, but cloud sync failed. Balance: ${result.state.balance.toFixed(2)}`,
      });
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to add money.',
      });
    } finally {
      setBankLoading(false);
    }
  };

  if (!authReady) {
    return (
      <View style={styles.loaderContainer}>
        <ActivityIndicator color="#ffffff" />
      </View>
    );
  }

  if (!currentUser) {
    return (
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card}>
          <Text style={styles.title}>Bank App</Text>
          <Text style={styles.subtitle}>{authMode === 'login' ? 'Login' : 'Sign Up'}</Text>

          {!firebaseConfigured ? (
            <Text style={styles.statusError}>
              Firebase not configured for BankApp. Missing: {missingFirebaseEnvKeys.join(', ')}
            </Text>
          ) : null}

          {authMode === 'signup' ? (
            <TextInput
              style={styles.input}
              placeholder="Full name"
              placeholderTextColor="#8a8aa3"
              value={name}
              onChangeText={setName}
            />
          ) : null}

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#8a8aa3"
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
          />

          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#8a8aa3"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          {authMode === 'signup' ? (
            <TextInput
              style={styles.input}
              placeholder="Confirm password"
              placeholderTextColor="#8a8aa3"
              secureTextEntry
              value={confirmPassword}
              onChangeText={setConfirmPassword}
            />
          ) : null}

          <TouchableOpacity style={styles.primaryButton} onPress={onEmailAuth} disabled={authDisabled}>
            {authLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.buttonText}>{authMode === 'login' ? 'Login' : 'Sign Up'}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => {
              setAuthMode((prev) => (prev === 'login' ? 'signup' : 'login'));
              setStatus(null);
            }}>
            <Text style={styles.buttonText}>
              {authMode === 'login' ? 'Create account' : 'Already have account? Login'}
            </Text>
          </TouchableOpacity>

          {status ? (
            <Text style={[styles.statusText, status.type === 'error' ? styles.statusError : styles.statusSuccess]}>
              {status.message}
            </Text>
          ) : null}
        </View>
        <StatusBar style="light" />
      </KeyboardAvoidingView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Bank App</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={onLogout} disabled={authLoading}>
          <Text style={styles.buttonText}>{authLoading ? 'Logging out...' : 'Logout'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Account number</Text>
        <Text style={styles.valueSmall}>{accountNumber ?? 'Generating...'}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Available Balance</Text>
        {bankLoading && !bankState ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.value}>{(bankState?.balance ?? 0).toFixed(2)}</Text>
        )}
      </View>

      <View style={styles.card}>
        <TextInput
          style={styles.input}
          placeholder="Add money"
          placeholderTextColor="#8a8aa3"
          keyboardType="decimal-pad"
          value={amountInput}
          onChangeText={setAmountInput}
        />
        <TouchableOpacity style={styles.primaryButton} onPress={onAddMoney} disabled={bankLoading}>
          {bankLoading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Add Money</Text>}
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Transactions</Text>
      {!bankState?.transactions.length ? (
        <Text style={styles.emptyText}>No transactions yet.</Text>
      ) : (
        bankState.transactions.slice(0, 20).map((transaction) => (
          <View key={transaction.id} style={styles.card}>
            <Text style={styles.valueSmall}>{transaction.type === 'credit' ? 'Credit' : 'Debit'}</Text>
            <Text style={styles.label}>Amount: {transaction.amount.toFixed(2)}</Text>
            <Text style={styles.label}>Note: {transaction.note}</Text>
            <Text style={styles.label}>Date: {new Date(transaction.createdAt).toLocaleString()}</Text>
          </View>
        ))
      )}

      {status ? (
        <Text style={[styles.statusText, status.type === 'error' ? styles.statusError : styles.statusSuccess]}>
          {status.message}
        </Text>
      ) : null}

      <StatusBar style="light" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  loaderContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  card: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 14,
    marginBottom: 12,
  },
  title: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    color: '#c7c7d1',
    marginBottom: 10,
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
  },
  label: {
    color: '#c7c7d1',
    marginBottom: 6,
  },
  value: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '800',
  },
  valueSmall: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 10,
    color: '#fff',
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: '#5b58ff',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryButton: {
    backgroundColor: '#2d2d4d',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  statusText: {
    marginTop: 8,
    fontSize: 13,
  },
  statusError: {
    color: '#ffb3b3',
  },
  statusSuccess: {
    color: '#b8f4d5',
  },
  emptyText: {
    color: '#a0a0a0',
    fontSize: 14,
  },
});
