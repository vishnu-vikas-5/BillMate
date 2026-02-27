import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';

import {
    addVirtualMoney,
    getBankState,
    getLinkedBankAccountInfo,
    type BankState,
    type LinkedBankAccountInfo,
} from '@/lib/bank';
import { auth } from '@/lib/firebase';

export default function BankScreen() {
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [bankState, setBankState] = useState<BankState | null>(null);
  const [bankAccountInfo, setBankAccountInfo] = useState<LinkedBankAccountInfo>({
    ownAccountNumber: null,
    linkedAccountNumber: null,
    linkedAccountOwnerUid: null,
  });
  const [amountInput, setAmountInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  const loadBank = useCallback(async () => {
    setLoading(true);
    try {
      const [state, info] = await Promise.all([getBankState(), getLinkedBankAccountInfo()]);
      setBankState(state);
      setBankAccountInfo(info);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!auth) {
      setCurrentUser(null);
      setAuthReady(true);
      return;
    }

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
    });

    return unsubscribeAuth;
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadBank();
    }, [loadBank])
  );

  useEffect(() => {
    if (authReady) {
      void loadBank();
    }
  }, [authReady, currentUser, loadBank]);

  const onAuthButtonPress = async () => {
    setStatus(null);

    if (!auth) {
      setStatus({ type: 'error', message: 'Authentication is not available on this device right now.' });
      return;
    }

    if (!currentUser) {
      router.push('/login');
      return;
    }

    try {
      setAuthLoading(true);
      await signOut(auth);
      setStatus({ type: 'success', message: 'Logged out successfully.' });
    } catch {
      setStatus({ type: 'error', message: 'Unable to log out right now.' });
    } finally {
      setAuthLoading(false);
    }
  };

  const onAddMoney = async () => {
    setStatus(null);
    const amount = Number.parseFloat(amountInput);

    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus({ type: 'error', message: 'Enter a valid amount to add.' });
      return;
    }

    setLoading(true);
    const nextState = await addVirtualMoney(amount, 'Manual top-up');
    setBankState(nextState);
    setAmountInput('');
    setStatus({ type: 'success', message: `Money added. New balance: ${nextState.balance.toFixed(2)}` });
    setLoading(false);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Virtual Bank</Text>
        <View style={styles.topActions}>
          <TouchableOpacity
            style={[styles.authButton, authLoading && styles.buttonDisabled]}
            onPress={onAuthButtonPress}
            disabled={authLoading}>
            <Text style={styles.buttonText}>
              {currentUser ? (authLoading ? 'Logging out...' : 'Logout') : 'Login / Sign Up'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
            <Text style={styles.buttonText}>Back</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.accountCard}>
        <Text style={styles.accountTitle}>Bank Account</Text>
        {!authReady ? (
          <Text style={styles.accountMeta}>Loading account...</Text>
        ) : !currentUser ? (
          <Text style={styles.accountMeta}>Login / Sign Up to generate and view your account number.</Text>
        ) : (
          <>
            <Text style={styles.accountMeta}>Account number: {bankAccountInfo.ownAccountNumber ?? 'Generating...'}</Text>
            <Text style={styles.accountMeta}>Linked account: {bankAccountInfo.linkedAccountNumber ?? 'Not linked'}</Text>
          </>
        )}
      </View>

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Available Balance</Text>
        <Text style={styles.balanceValue}>
          {loading && !bankState ? 'Loading...' : `${(bankState?.balance ?? 0).toFixed(2)}`}
        </Text>
      </View>

      <View style={styles.formCard}>
        <TextInput
          style={styles.input}
          placeholder="Add virtual money"
          placeholderTextColor="#8a8aa3"
          keyboardType="decimal-pad"
          value={amountInput}
          onChangeText={setAmountInput}
        />

        <TouchableOpacity style={styles.primaryButton} onPress={onAddMoney} disabled={loading}>
          {loading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Add Money</Text>}
        </TouchableOpacity>
      </View>

      {status ? (
        <Text style={[styles.statusText, status.type === 'error' ? styles.statusError : styles.statusSuccess]}>
          {status.message}
        </Text>
      ) : null}

      <Text style={styles.sectionTitle}>Transactions</Text>
      {!bankState?.transactions.length ? (
        <Text style={styles.emptyText}>No transactions yet.</Text>
      ) : (
        bankState.transactions.slice(0, 20).map((transaction) => (
          <View key={transaction.id} style={styles.txCard}>
            <Text style={styles.txTitle}>{transaction.type === 'credit' ? 'Credit' : 'Debit'}</Text>
            <Text style={styles.txMeta}>Amount: {transaction.amount.toFixed(2)}</Text>
            <Text style={styles.txMeta}>Note: {transaction.note}</Text>
            <Text style={styles.txMeta}>Date: {new Date(transaction.createdAt).toLocaleString()}</Text>
          </View>
        ))
      )}

      <StatusBar style="light" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 24,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
  },
  authButton: {
    backgroundColor: '#2d2d4d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  backButton: {
    backgroundColor: '#2d2d4d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  accountCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 14,
    marginBottom: 14,
  },
  accountTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },
  accountMeta: {
    color: '#c7c7d1',
    fontSize: 13,
    marginBottom: 4,
  },
  balanceCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 14,
    marginBottom: 14,
  },
  balanceLabel: {
    color: '#c7c7d1',
    marginBottom: 8,
  },
  balanceValue: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '800',
  },
  formCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 12,
    marginBottom: 12,
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
  },
  buttonText: {
    color: '#fff',
    fontWeight: '700',
  },
  statusText: {
    marginBottom: 12,
    fontSize: 14,
  },
  statusError: {
    color: '#ffb3b3',
  },
  statusSuccess: {
    color: '#b8f4d5',
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 10,
  },
  emptyText: {
    color: '#a0a0a0',
    fontSize: 14,
  },
  txCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 10,
    backgroundColor: '#17172a',
    padding: 12,
    marginBottom: 10,
  },
  txTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  txMeta: {
    color: '#c7c7d1',
    fontSize: 13,
    marginBottom: 2,
  },
});
