import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';

import { addVirtualMoney, getBankState, type BankState } from '@/lib/bank';

export default function BankScreen() {
  const [bankState, setBankState] = useState<BankState | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  const loadBank = useCallback(async () => {
    setLoading(true);
    const state = await getBankState();
    setBankState(state);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadBank();
    }, [loadBank])
  );

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
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.buttonText}>Back</Text>
        </TouchableOpacity>
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
  title: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '800',
  },
  backButton: {
    backgroundColor: '#2d2d4d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
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
