import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
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
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import {
    addVirtualMoney,
    ensureBankAccountForUser,
    getBankState,
    transferToAccountByNumber,
    type BankState,
} from './lib/bank';
import { auth, firebaseConfigured, missingFirebaseEnvKeys } from './lib/firebase';

type AuthMode = 'login' | 'signup';

function parsePaymentQr(rawValue: string): { accountNumber: string; amount?: number } | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const bmAccountRegex = /BM[A-Z0-9]{6,}/i;

  const parseAmount = (value: string | null | undefined): number | undefined => {
    if (!value) {
      return undefined;
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  try {
    const parsed = JSON.parse(trimmed) as {
      accountNumber?: unknown;
      amount?: unknown;
    };

    if (typeof parsed.accountNumber === 'string') {
      const accountNumber = parsed.accountNumber.trim().toUpperCase();
      if (bmAccountRegex.test(accountNumber)) {
        return {
          accountNumber,
          amount: parseAmount(String(parsed.amount ?? '')),
        };
      }
    }
  } catch {
  }

  if (trimmed.startsWith('bank://') || trimmed.startsWith('billmate://')) {
    try {
      const parsedUrl = new URL(trimmed);
      const account = parsedUrl.searchParams.get('account')?.trim().toUpperCase();
      if (account && bmAccountRegex.test(account)) {
        return {
          accountNumber: account,
          amount: parseAmount(parsedUrl.searchParams.get('amount')),
        };
      }
    } catch {
    }
  }

  const accountMatch = trimmed.toUpperCase().match(bmAccountRegex);
  if (!accountMatch) {
    return null;
  }

  const amountMatch = trimmed.match(/(?:amount|amt)\s*[:=]\s*([0-9]+(?:\.[0-9]{1,2})?)/i) ?? trimmed.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\b/);
  return {
    accountNumber: accountMatch[0],
    amount: parseAmount(amountMatch?.[1]),
  };
}

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
  const [myQrVisible, setMyQrVisible] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [hasScannedCurrentSession, setHasScannedCurrentSession] = useState(false);
  const [payModalVisible, setPayModalVisible] = useState(false);
  const [payAccountNumber, setPayAccountNumber] = useState('');
  const [payAmountInput, setPayAmountInput] = useState('');
  const [payStatus, setPayStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  const [successVisible, setSuccessVisible] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [bankLoading, setBankLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

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

  const onCopyAccountNumber = async () => {
    if (!accountNumber) {
      setStatus({ type: 'error', message: 'Account number not available yet.' });
      return;
    }

    await Clipboard.setStringAsync(accountNumber);
    setStatus({ type: 'success', message: 'Account number copied.' });
  };

  const onOpenScanner = async () => {
    setStatus(null);

    if (Platform.OS === 'web') {
      setStatus({ type: 'error', message: 'QR scanning is available on mobile app (Android/iOS).' });
      return;
    }

    const permissionResult = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();

    if (!permissionResult.granted) {
      setStatus({ type: 'error', message: 'Camera permission is required to scan QR.' });
      return;
    }

    setHasScannedCurrentSession(false);
    setScannerVisible(true);
  };

  const onQrScanned = async (event: BarcodeScanningResult) => {
    if (hasScannedCurrentSession) {
      return;
    }

    setHasScannedCurrentSession(true);
    setScannerVisible(false);

    const parsed = parsePaymentQr(event.data);
    if (!parsed) {
      setStatus({ type: 'error', message: 'Invalid QR. Scan a valid Bank payment QR.' });
      return;
    }

    setPayAccountNumber(parsed.accountNumber);
    setPayAmountInput(parsed.amount ? parsed.amount.toFixed(2) : '');
    setPayStatus(null);
    setPayModalVisible(true);
  };

  const onPayNow = async () => {
    setStatus(null);
    setPayStatus(null);

    const amount = Number.parseFloat(payAmountInput.trim().replace(/,/g, '.'));
    if (!payAccountNumber.trim()) {
      setPayStatus({ type: 'error', message: 'Scan a QR first.' });
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      setPayStatus({ type: 'error', message: 'Enter a valid amount.' });
      return;
    }

    setBankLoading(true);
    try {
      const result = await transferToAccountByNumber(payAccountNumber, amount, 'QR payment');
      setBankState(result.state);

      if (!result.ok) {
        setPayStatus({ type: 'error', message: result.message });
        return;
      }

      setPayModalVisible(false);
      setPayAmountInput('');
      setPayStatus(null);
      setSuccessMessage(result.message);
      setSuccessVisible(true);
    } catch (error) {
      setPayStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Payment failed. Please try again.',
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
    <View style={styles.screen}>
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Bank App</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={onLogout} disabled={authLoading}>
          <Text style={styles.buttonText}>{authLoading ? 'Logging out...' : 'Logout'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Account number</Text>
        <TouchableOpacity style={styles.copyRow} onPress={onCopyAccountNumber} disabled={!accountNumber}>
          <Text style={styles.valueSmall}>{accountNumber ?? 'Generating...'}</Text>
          {accountNumber ? <Text style={styles.copyHint}>Tap to copy</Text> : null}
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>My QR</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => setMyQrVisible(true)}>
          <Text style={styles.buttonText}>Show My QR</Text>
        </TouchableOpacity>
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

      <View style={styles.card}>
        <Text style={styles.label}>Scan & Pay</Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={onOpenScanner} disabled={bankLoading}>
          <Text style={styles.buttonText}>Scan QR</Text>
        </TouchableOpacity>
        <Text style={styles.label}>After scanning, enter amount and pay.</Text>
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

    </ScrollView>

    <Modal visible={scannerVisible} transparent animationType="slide" onRequestClose={() => setScannerVisible(false)}>
      <View style={styles.scannerOverlay}>
        <View style={styles.scannerCard}>
          <Text style={styles.sectionTitle}>Scan QR</Text>
          <CameraView
            style={styles.scannerCamera}
            facing="back"
            barcodeScannerSettings={{
              barcodeTypes: ['qr'],
            }}
            onBarcodeScanned={onQrScanned}
          />
          <Text style={styles.label}>Point your camera at BankApp QR</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setScannerVisible(false)}>
            <Text style={styles.buttonText}>Close Scanner</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>

    <Modal visible={myQrVisible} transparent animationType="slide" onRequestClose={() => setMyQrVisible(false)}>
      <View style={styles.scannerOverlay}>
        <View style={styles.scannerCard}>
          <Text style={styles.sectionTitle}>My QR</Text>
          {accountNumber ? (
            <>
              <View style={styles.qrContainer}>
                <QRCode value={`bank://pay?account=${accountNumber}`} size={220} />
              </View>
              <Text style={styles.label}>Scan this QR to pay this account.</Text>
            </>
          ) : (
            <Text style={styles.label}>Generating QR...</Text>
          )}
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setMyQrVisible(false)}>
            <Text style={styles.buttonText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>

    <Modal visible={payModalVisible} transparent animationType="slide" onRequestClose={() => setPayModalVisible(false)}>
      <View style={styles.scannerOverlay}>
        <View style={styles.scannerCard}>
          <Text style={styles.sectionTitle}>Pay to Account</Text>
          <Text style={styles.label}>Account: {payAccountNumber}</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter amount"
            placeholderTextColor="#8a8aa3"
            keyboardType="decimal-pad"
            value={payAmountInput}
            onChangeText={setPayAmountInput}
          />
          {payStatus ? (
            <Text style={[styles.statusText, payStatus.type === 'error' ? styles.statusError : styles.statusSuccess]}>
              {payStatus.message}
            </Text>
          ) : null}
          <TouchableOpacity style={styles.primaryButton} onPress={onPayNow} disabled={bankLoading}>
            {bankLoading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Pay</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => {
              setPayStatus(null);
              setPayModalVisible(false);
            }}>
            <Text style={styles.buttonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>

    <Modal visible={successVisible} transparent animationType="fade" onRequestClose={() => setSuccessVisible(false)}>
      <View style={styles.successOverlay}>
        <View style={styles.successCard}>
          <Text style={styles.successTitle}>Payment Successful</Text>
          <Text style={styles.successText}>{successMessage}</Text>
          <TouchableOpacity style={styles.successButton} onPress={() => setSuccessVisible(false)}>
            <Text style={styles.buttonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>

    <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  scrollContent: {
    flexGrow: 1,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
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
  copyRow: {
    gap: 4,
  },
  copyHint: {
    color: '#b8f4d5',
    fontSize: 12,
  },
  qrContainer: {
    alignSelf: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
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
  scannerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  scannerCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 14,
    gap: 10,
  },
  scannerCamera: {
    width: '100%',
    height: 320,
    borderRadius: 10,
    overflow: 'hidden',
  },
  successOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  successCard: {
    backgroundColor: '#16a34a',
    borderRadius: 12,
    padding: 18,
    alignItems: 'center',
  },
  successTitle: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 8,
  },
  successText: {
    color: '#ecfdf5',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 14,
  },
  successButton: {
    backgroundColor: '#166534',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  emptyText: {
    color: '#a0a0a0',
    fontSize: 14,
  },
});
