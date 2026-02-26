import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { getBankState, getLinkedBankAccountInfo, type BankState, type LinkedBankAccountInfo } from '@/lib/bank';

type SavingsSummary = {
  totalCredits: number;
  totalDebits: number;
};

function getSavingsSummary(state: BankState): SavingsSummary {
  return state.transactions.reduce(
    (summary, transaction) => {
      if (transaction.type === 'credit') {
        return { ...summary, totalCredits: summary.totalCredits + transaction.amount };
      }

      return { ...summary, totalDebits: summary.totalDebits + transaction.amount };
    },
    { totalCredits: 0, totalDebits: 0 }
  );
}

export default function SavingsScreen() {
  const [loading, setLoading] = useState(true);
  const [bankState, setBankState] = useState<BankState | null>(null);
  const [accountInfo, setAccountInfo] = useState<LinkedBankAccountInfo>({
    ownAccountNumber: null,
    linkedAccountNumber: null,
    linkedAccountOwnerUid: null,
  });

  const loadSavings = useCallback(async () => {
    setLoading(true);
    try {
      const [state, info] = await Promise.all([getBankState(), getLinkedBankAccountInfo()]);
      setBankState(state);
      setAccountInfo(info);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadSavings();
    }, [loadSavings])
  );

  const summary = bankState ? getSavingsSummary(bankState) : { totalCredits: 0, totalDebits: 0 };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Savings Vault</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.buttonText}>Back</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Current Remaining Savings</Text>
        {loading ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.value}>{(bankState?.balance ?? 0).toFixed(2)}</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Account</Text>
        <Text style={styles.meta}>Account number: {accountInfo.ownAccountNumber ?? 'Not available'}</Text>
        <Text style={styles.meta}>Linked account: {accountInfo.linkedAccountNumber ?? 'Not linked'}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Summary</Text>
        <Text style={styles.meta}>Total added: {summary.totalCredits.toFixed(2)}</Text>
        <Text style={styles.meta}>Total deducted: {summary.totalDebits.toFixed(2)}</Text>
        <Text style={styles.meta}>Transactions: {bankState?.transactions.length ?? 0}</Text>
      </View>

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
  buttonText: {
    color: '#fff',
    fontWeight: '700',
  },
  card: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 14,
    marginBottom: 14,
  },
  label: {
    color: '#c7c7d1',
    marginBottom: 10,
  },
  value: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '800',
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
  },
  meta: {
    color: '#c7c7d1',
    fontSize: 14,
    marginBottom: 4,
  },
});
