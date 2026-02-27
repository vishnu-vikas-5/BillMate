import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';

import { getLinkedBankBalanceByAccountNumber } from '@/lib/bank-bridge';
import { auth, db, firebaseConfigured, missingFirebaseEnvKeys } from '@/lib/firebase';

type BillingCycle = 'monthly' | 'yearly';
type SectionTab = 'home' | 'subscriptions';

type SubscriptionItem = {
  id: string;
  platform: string;
  amount: number;
  billingCycle: BillingCycle;
  startDate: string;
  reminderDays: number;
};

type SubscriptionDoc = {
  platform?: unknown;
  amount?: unknown;
  billingCycle?: unknown;
  startDate?: unknown;
  reminderDays?: unknown;
};

const LOCAL_SUBSCRIPTIONS_KEY = 'billmate:local-subscriptions';

function normalizeAccountNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function isValidAccountNumber(value: string): boolean {
  return /^BM[A-Z0-9]{6,}$/.test(value);
}

function parseDateInput(value: string): Date | null {
  const trimmed = value.trim();
  const slashMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  const dashMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);

  let year = 0;
  let monthIndex = 0;
  let day = 0;

  if (slashMatch) {
    day = Number(slashMatch[1]);
    monthIndex = Number(slashMatch[2]) - 1;
    year = Number(slashMatch[3]);
  } else if (dashMatch) {
    year = Number(dashMatch[1]);
    monthIndex = Number(dashMatch[2]) - 1;
    day = Number(dashMatch[3]);
  } else {
    return null;
  }

  const parsedDate = new Date(year, monthIndex, day);

  if (
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== monthIndex ||
    parsedDate.getDate() !== day
  ) {
    return null;
  }

  parsedDate.setHours(0, 0, 0, 0);
  return parsedDate;
}

function getNextRenewalDate(startDate: string, billingCycle: BillingCycle): Date | null {
  const baseDate = parseDateInput(startDate);
  if (!baseDate) {
    return null;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const nextDate = new Date(baseDate);
  while (nextDate < today) {
    if (billingCycle === 'monthly') {
      nextDate.setMonth(nextDate.getMonth() + 1);
    } else {
      nextDate.setFullYear(nextDate.getFullYear() + 1);
    }
  }

  return nextDate;
}

function formatDate(value: Date): string {
  const day = String(value.getDate()).padStart(2, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const year = value.getFullYear();
  return `${day}/${month}/${year}`;
}

function getDaysUntil(value: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((value.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function monthTitle(value: Date): string {
  return value.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function buildCalendarDays(value: Date): Array<Date | null> {
  const year = value.getFullYear();
  const month = value.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const days: Array<Date | null> = [];

  for (let i = 0; i < firstDay; i += 1) {
    days.push(null);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push(new Date(year, month, day));
  }

  while (days.length % 7 !== 0) {
    days.push(null);
  }

  return days;
}

export default function HomeScreen() {
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [signOutLoading, setSignOutLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<SectionTab>('home');
  const [showAddForm, setShowAddForm] = useState(false);

  const [platformName, setPlatformName] = useState('');
  const [amountValue, setAmountValue] = useState('');
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [startDate, setStartDate] = useState('');
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [reminderDays, setReminderDays] = useState('3');

  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  const [cloudSyncBlocked, setCloudSyncBlocked] = useState(false);

  const [cloudSubscriptions, setCloudSubscriptions] = useState<SubscriptionItem[]>([]);
  const [localSubscriptions, setLocalSubscriptions] = useState<SubscriptionItem[]>([]);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);
  const [bankAccountInput, setBankAccountInput] = useState('');
  const [linkedBankAccountNumber, setLinkedBankAccountNumber] = useState<string | null>(null);
  const [linkingBankAccount, setLinkingBankAccount] = useState(false);
  const [linkedBankBalance, setLinkedBankBalance] = useState<number | null>(null);
  const [loadingLinkedBankBalance, setLoadingLinkedBankBalance] = useState(false);
  const [linkedBankBalanceMessage, setLinkedBankBalanceMessage] = useState<string | null>(null);

  const subscriptions = currentUser ? [...localSubscriptions, ...cloudSubscriptions] : localSubscriptions;

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

  useEffect(() => {
    const loadLocalSubscriptions = async () => {
      try {
        const storedValue = await AsyncStorage.getItem(LOCAL_SUBSCRIPTIONS_KEY);
        if (!storedValue) {
          return;
        }

        const parsedValue = JSON.parse(storedValue) as unknown;
        if (!Array.isArray(parsedValue)) {
          return;
        }

        const validItems = parsedValue
          .map((item): SubscriptionItem | null => {
            if (!item || typeof item !== 'object') {
              return null;
            }

            const candidate = item as Partial<SubscriptionItem>;

            if (
              typeof candidate.id !== 'string' ||
              typeof candidate.platform !== 'string' ||
              typeof candidate.amount !== 'number' ||
              (candidate.billingCycle !== 'monthly' && candidate.billingCycle !== 'yearly') ||
              typeof candidate.startDate !== 'string' ||
              typeof candidate.reminderDays !== 'number'
            ) {
              return null;
            }

            if (!parseDateInput(candidate.startDate)) {
              return null;
            }

            return {
              id: candidate.id,
              platform: candidate.platform,
              amount: candidate.amount,
              billingCycle: candidate.billingCycle,
              startDate: candidate.startDate,
              reminderDays: candidate.reminderDays,
            };
          })
          .filter((item): item is SubscriptionItem => item !== null);

        setLocalSubscriptions(validItems);
      } catch {
        setLocalSubscriptions([]);
      }
    };

    loadLocalSubscriptions();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(LOCAL_SUBSCRIPTIONS_KEY, JSON.stringify(localSubscriptions)).catch(() => {
      setStatus({ type: 'error', message: 'Unable to persist local subscriptions on this device.' });
    });
  }, [localSubscriptions]);

  useEffect(() => {
    if (!currentUser || !firebaseConfigured) {
      setCloudSubscriptions([]);
      setCloudSyncBlocked(false);
      return;
    }

    setLoadingSubscriptions(true);
    setCloudSyncBlocked(false);
    const subscriptionsQuery = query(
      collection(db, 'users', currentUser.uid, 'subscriptions'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribeSubscriptions = onSnapshot(
      subscriptionsQuery,
      (snapshot) => {
        const items = snapshot.docs.map((itemDoc) => {
          const data = itemDoc.data() as SubscriptionDoc;

          return {
            id: itemDoc.id,
            platform: typeof data.platform === 'string' ? data.platform : 'Subscription',
            amount:
              typeof data.amount === 'number'
                ? data.amount
                : Number.parseFloat(String(data.amount ?? '0')) || 0,
            billingCycle: data.billingCycle === 'yearly' ? 'yearly' : 'monthly',
            startDate:
              typeof data.startDate === 'string' && parseDateInput(data.startDate)
                ? data.startDate
                : formatDate(new Date()),
            reminderDays:
              typeof data.reminderDays === 'number'
                ? data.reminderDays
                : Number.parseInt(String(data.reminderDays ?? '3'), 10) || 3,
          } as SubscriptionItem;
        });

        setCloudSubscriptions(items);
        setLoadingSubscriptions(false);
      },
      () => {
        setLoadingSubscriptions(false);
        setCloudSyncBlocked(true);
      }
    );

    return unsubscribeSubscriptions;
  }, [currentUser]);

  useEffect(() => {
    const loadLinkedBankAccount = async () => {
      if (!currentUser || !firebaseConfigured) {
        setLinkedBankAccountNumber(null);
        setBankAccountInput('');
        return;
      }

      try {
        const userSnapshot = await getDoc(doc(db, 'users', currentUser.uid));
        const linked = userSnapshot.data()?.linkedBankAccountNumber;
        const normalizedLinked = typeof linked === 'string' && linked.trim() ? normalizeAccountNumber(linked) : null;
        setLinkedBankAccountNumber(normalizedLinked);
        setBankAccountInput(normalizedLinked ?? '');
      } catch {
        setLinkedBankAccountNumber(null);
      }
    };

    void loadLinkedBankAccount();
  }, [currentUser]);

  useEffect(() => {
    const loadLinkedBalance = async () => {
      if (!linkedBankAccountNumber) {
        setLinkedBankBalance(null);
        setLinkedBankBalanceMessage(null);
        setLoadingLinkedBankBalance(false);
        return;
      }

      setLoadingLinkedBankBalance(true);
      const result = await getLinkedBankBalanceByAccountNumber(linkedBankAccountNumber);
      setLinkedBankBalance(result.balance);
      setLinkedBankBalanceMessage(result.message ?? null);
      setLoadingLinkedBankBalance(false);
    };

    void loadLinkedBalance();
  }, [linkedBankAccountNumber]);

  const upcomingRenewals = useMemo(
    () =>
      subscriptions
        .map((item) => {
          const nextRenewal = getNextRenewalDate(item.startDate, item.billingCycle);
          if (!nextRenewal) {
            return null;
          }

          const reminderDate = new Date(nextRenewal);
          reminderDate.setDate(reminderDate.getDate() - item.reminderDays);

          return {
            ...item,
            nextRenewal,
            reminderDate,
            daysLeft: getDaysUntil(nextRenewal),
          };
        })
        .filter(
          (
            item
          ): item is SubscriptionItem & {
            nextRenewal: Date;
            reminderDate: Date;
            daysLeft: number;
          } => item !== null
        )
        .sort((left, right) => left.nextRenewal.getTime() - right.nextRenewal.getTime()),
    [subscriptions]
  );

  const totalMonthlyEstimate = useMemo(() => {
    return subscriptions.reduce((total, item) => {
      if (item.billingCycle === 'monthly') {
        return total + item.amount;
      }

      return total + item.amount / 12;
    }, 0);
  }, [subscriptions]);

  const onAuthButtonPress = async () => {
    if (!auth) {
      setStatus({ type: 'error', message: 'Authentication is not available on this device right now.' });
      return;
    }

    if (!currentUser) {
      router.push('/login');
      return;
    }

    try {
      setSignOutLoading(true);
      await signOut(auth);
      setStatus({ type: 'success', message: 'Logged out successfully.' });
    } catch {
      setStatus({ type: 'error', message: 'Unable to log out right now.' });
    } finally {
      setSignOutLoading(false);
    }
  };

  const onLinkBankAccount = async () => {
    setStatus(null);

    if (!currentUser) {
      setStatus({ type: 'error', message: 'Login required to link a bank account.' });
      return;
    }

    if (!firebaseConfigured) {
      setStatus({ type: 'error', message: `Firebase not configured: ${missingFirebaseEnvKeys.join(', ')}` });
      return;
    }

    const normalized = normalizeAccountNumber(bankAccountInput);
    if (!isValidAccountNumber(normalized)) {
      setStatus({ type: 'error', message: 'Enter a valid account number (example: BM12345678).' });
      return;
    }

    setLinkingBankAccount(true);
    try {
      await setDoc(
        doc(db, 'users', currentUser.uid),
        {
          linkedBankAccountNumber: normalized,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setLinkedBankAccountNumber(normalized);
      setBankAccountInput(normalized);
      setStatus({ type: 'success', message: 'Bank account linked in BillMate.' });
    } catch {
      setStatus({ type: 'error', message: 'Unable to link bank account right now.' });
    } finally {
      setLinkingBankAccount(false);
    }
  };

  const onUnlinkBankAccount = async () => {
    setStatus(null);

    if (!currentUser) {
      setStatus({ type: 'error', message: 'Login required to unlink bank account.' });
      return;
    }

    if (!firebaseConfigured) {
      setStatus({ type: 'error', message: `Firebase not configured: ${missingFirebaseEnvKeys.join(', ')}` });
      return;
    }

    setLinkingBankAccount(true);
    try {
      await setDoc(
        doc(db, 'users', currentUser.uid),
        {
          linkedBankAccountNumber: null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setLinkedBankAccountNumber(null);
      setBankAccountInput('');
      setStatus({ type: 'success', message: 'Bank account unlinked from BillMate.' });
    } catch {
      setStatus({ type: 'error', message: 'Unable to unlink bank account right now.' });
    } finally {
      setLinkingBankAccount(false);
    }
  };

  const resetForm = () => {
    setPlatformName('');
    setAmountValue('');
    setBillingCycle('monthly');
    setStartDate('');
    setReminderDays('3');
  };

  const onAddSubscription = async () => {
    setStatus(null);

    const trimmedPlatform = platformName.trim();
    const parsedAmount = Number.parseFloat(amountValue);
    const parsedReminderDays = Number.parseInt(reminderDays, 10);
    const parsedStartDate = parseDateInput(startDate);

    if (!trimmedPlatform) {
      setStatus({ type: 'error', message: 'Platform name is required.' });
      return;
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setStatus({ type: 'error', message: 'Enter a valid rate amount.' });
      return;
    }

    if (!parsedStartDate) {
      setStatus({ type: 'error', message: 'Start date must be in DD/MM/YYYY format.' });
      return;
    }

    if (!Number.isInteger(parsedReminderDays) || parsedReminderDays < 0) {
      setStatus({ type: 'error', message: 'Reminder must be 0 or more days.' });
      return;
    }

    const payload = {
      platform: trimmedPlatform,
      amount: parsedAmount,
      billingCycle,
      startDate: formatDate(parsedStartDate),
      reminderDays: parsedReminderDays,
    };

    if (currentUser && firebaseConfigured) {
      try {
        await addDoc(collection(db, 'users', currentUser.uid, 'subscriptions'), {
          ...payload,
          createdAt: serverTimestamp(),
        });
        setCloudSyncBlocked(false);
        setStatus({
          type: 'success',
          message: 'Subscription added.',
        });
      } catch {
        const localItem: SubscriptionItem = {
          id: `local-${Date.now()}`,
          ...payload,
        };
        setLocalSubscriptions((previous) => [localItem, ...previous]);
        setCloudSyncBlocked(true);
        setStatus({
          type: 'success',
          message: 'Subscription added locally. Cloud save blocked by Firestore permissions.',
        });
      }
    } else {
      const localItem: SubscriptionItem = {
        id: `local-${Date.now()}`,
        ...payload,
      };
      setLocalSubscriptions((previous) => [localItem, ...previous]);
      setStatus({
        type: 'success',
        message: currentUser
          ? `Firebase not configured: ${missingFirebaseEnvKeys.join(', ')}`
          : 'Subscription added locally. Log in to sync with cloud.',
      });
    }

    resetForm();
    setShowAddForm(false);
  };

  const onDeleteSubscription = async (item: SubscriptionItem) => {
    setStatus(null);

    const isLocalItem = item.id.startsWith('local-');

    if (isLocalItem || !currentUser || !firebaseConfigured) {
      setLocalSubscriptions((previous) => previous.filter((subscription) => subscription.id !== item.id));
      setStatus({ type: 'success', message: 'Subscription removed.' });
      return;
    }

    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'subscriptions', item.id));
      setCloudSubscriptions((previous) => previous.filter((subscription) => subscription.id !== item.id));
      setStatus({ type: 'success', message: 'Subscription removed from cloud.' });
      setCloudSyncBlocked(false);
    } catch {
      setStatus({
        type: 'error',
        message: 'Could not delete from cloud due to Firestore permissions.',
      });
      setCloudSyncBlocked(true);
    }
  };

  const confirmDeleteSubscription = (item: SubscriptionItem) => {
    if (Platform.OS === 'web') {
      const confirmFn = (globalThis as { confirm?: (message: string) => boolean }).confirm;
      const confirmed = confirmFn ? confirmFn(`Delete ${item.platform}?`) : true;

      if (confirmed) {
        void onDeleteSubscription(item);
      }
      return;
    }

    Alert.alert('Delete subscription', `Delete ${item.platform}?`, [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes',
        style: 'destructive',
        onPress: () => {
          void onDeleteSubscription(item);
        },
      },
    ]);
  };

  const openCalendar = () => {
    const selectedDate = parseDateInput(startDate) ?? new Date();
    setCalendarMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
    setShowCalendar(true);
  };

  const selectCalendarDate = (value: Date) => {
    setStartDate(formatDate(value));
    setShowCalendar(false);
  };

  const calendarDays = useMemo(() => buildCalendarDays(calendarMonth), [calendarMonth]);

  const renderHomeSection = () => (
    <View>
      <View style={styles.summaryCard}>
        <Text style={styles.summaryTitle}>Overview</Text>
        <Text style={styles.summaryText}>Total subscriptions: {subscriptions.length}</Text>
        <Text style={styles.summaryText}>Estimated monthly spend: {totalMonthlyEstimate.toFixed(2)}</Text>
      </View>

      <Text style={styles.sectionTitle}>Upcoming renewals</Text>
      {!upcomingRenewals.length ? (
        <Text style={styles.emptyText}>No subscriptions yet. Add one in Subscription Management.</Text>
      ) : (
        upcomingRenewals.slice(0, 5).map((item) => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.cardTitle}>{item.platform}</Text>
            <Text style={styles.cardMeta}>Rate: {item.amount}</Text>
            <Text style={styles.cardMeta}>Cycle: {item.billingCycle}</Text>
            <Text style={styles.cardMeta}>Next renewal: {formatDate(item.nextRenewal)}</Text>
            <Text style={styles.cardMeta}>Reminder date: {formatDate(item.reminderDate)}</Text>
            <Text style={styles.cardMeta}>Days left: {item.daysLeft}</Text>
          </View>
        ))
      )}
    </View>
  );

  const renderSubscriptionSection = () => (
    <View>
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={() => {
          setShowAddForm((previous) => !previous);
          setStatus(null);
        }}>
        <Text style={styles.buttonText}>{showAddForm ? 'Close Form' : '+ Add Subscription'}</Text>
      </TouchableOpacity>

      {showAddForm ? (
        <View style={styles.formCard}>
          <TextInput
            style={styles.input}
            placeholder="Platform (Netflix, Spotify...)"
            placeholderTextColor="#8a8aa3"
            value={platformName}
            onChangeText={setPlatformName}
          />

          <TextInput
            style={styles.input}
            placeholder="Rate amount"
            placeholderTextColor="#8a8aa3"
            keyboardType="decimal-pad"
            value={amountValue}
            onChangeText={setAmountValue}
          />

          <View style={styles.cycleRow}>
            <TouchableOpacity
              style={[styles.cycleButton, billingCycle === 'monthly' && styles.cycleButtonActive]}
              onPress={() => setBillingCycle('monthly')}>
              <Text style={styles.buttonText}>Monthly</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cycleButton, billingCycle === 'yearly' && styles.cycleButtonActive]}
              onPress={() => setBillingCycle('yearly')}>
              <Text style={styles.buttonText}>Yearly</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.dateButton} onPress={openCalendar}>
            <Text style={startDate ? styles.dateButtonText : styles.dateButtonPlaceholder}>
              {startDate || 'Starting date (DD/MM/YYYY)'}
            </Text>
          </TouchableOpacity>

          <TextInput
            style={styles.input}
            placeholder="Reminder days before renewal"
            placeholderTextColor="#8a8aa3"
            keyboardType="number-pad"
            value={reminderDays}
            onChangeText={setReminderDays}
          />

          <TouchableOpacity style={styles.secondaryButton} onPress={onAddSubscription}>
            <Text style={styles.buttonText}>Save Subscription</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Saved subscriptions ({subscriptions.length})</Text>
      {loadingSubscriptions ? (
        <ActivityIndicator color="#ffffff" />
      ) : subscriptions.length === 0 ? (
        <Text style={styles.emptyText}>No subscriptions added yet.</Text>
      ) : (
        subscriptions.map((item) => {
          const nextRenewal = getNextRenewalDate(item.startDate, item.billingCycle);
          return (
            <View key={item.id} style={styles.card}>
              <Text style={styles.cardTitle}>{item.platform}</Text>
              <Text style={styles.cardMeta}>Rate: {item.amount}</Text>
              <Text style={styles.cardMeta}>Cycle: {item.billingCycle}</Text>
              <Text style={styles.cardMeta}>Start date: {item.startDate}</Text>
              <Text style={styles.cardMeta}>Reminder: {item.reminderDays} day(s) before</Text>
              <Text style={styles.cardMeta}>
                Next renewal: {nextRenewal ? formatDate(nextRenewal) : 'Invalid date'}
              </Text>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => confirmDeleteSubscription(item)}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          );
        })
      )}
    </View>
  );

  if (!authReady) {
    return (
      <View style={styles.loaderContainer}>
        <ActivityIndicator color="#ffffff" />
        <Text style={styles.loaderText}>Loading...</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topBar}>
        <Text style={styles.pageTitle}>BillMate</Text>
        <TouchableOpacity
          style={[styles.authButton, signOutLoading && styles.buttonDisabled]}
          onPress={onAuthButtonPress}
          disabled={signOutLoading}>
          <Text style={styles.buttonText}>
            {currentUser ? (signOutLoading ? 'Logging out...' : 'Logout') : 'Login / Sign Up'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.navBar}>
        <TouchableOpacity
          style={[styles.navButton, activeTab === 'home' && styles.navButtonActive]}
          onPress={() => setActiveTab('home')}>
          <Text style={styles.buttonText}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.navButton, activeTab === 'subscriptions' && styles.navButtonActive]}
          onPress={() => setActiveTab('subscriptions')}>
          <Text style={styles.buttonText}>Subscription Management</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.accountCard}>
        <Text style={styles.accountTitle}>Linked Bank Account</Text>
        <Text style={styles.accountMeta}>Linked number: {linkedBankAccountNumber ?? 'Not linked'}</Text>
        {linkedBankAccountNumber ? (
          loadingLinkedBankBalance ? (
            <Text style={styles.accountMeta}>Linked balance: Loading...</Text>
          ) : linkedBankBalance !== null ? (
            <Text style={styles.accountMeta}>Linked balance: {linkedBankBalance.toFixed(2)}</Text>
          ) : (
            <Text style={styles.accountMeta}>Linked balance: Not available</Text>
          )
        ) : null}
        {linkedBankBalanceMessage ? (
          <Text style={styles.accountWarning}>{linkedBankBalanceMessage}</Text>
        ) : null}

        <TextInput
          style={styles.input}
          placeholder="Enter account number (BM...)"
          placeholderTextColor="#8a8aa3"
          autoCapitalize="characters"
          value={bankAccountInput}
          onChangeText={setBankAccountInput}
        />

        <View style={styles.accountActionRow}>
          <TouchableOpacity
            style={[styles.secondaryButton, styles.accountActionButton, linkingBankAccount && styles.buttonDisabled]}
            onPress={onLinkBankAccount}
            disabled={linkingBankAccount}>
            <Text style={styles.buttonText}>{linkingBankAccount ? 'Linking...' : 'Link Account'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.authButton, styles.accountActionButton, linkingBankAccount && styles.buttonDisabled]}
            onPress={onUnlinkBankAccount}
            disabled={linkingBankAccount}>
            <Text style={styles.buttonText}>Unlink</Text>
          </TouchableOpacity>
        </View>
      </View>

      {status ? (
        <Text style={[styles.statusText, status.type === 'error' ? styles.statusError : styles.statusSuccess]}>
          {status.message}
        </Text>
      ) : null}

      {currentUser && cloudSyncBlocked ? (
        <Text style={styles.syncWarningText}>
          Cloud sync is blocked by Firestore permissions. Your subscriptions are saved locally on this device.
        </Text>
      ) : null}

      {activeTab === 'home' ? renderHomeSection() : renderSubscriptionSection()}

      <StatusBar style="light" />
    </ScrollView>

    <Modal transparent animationType="fade" visible={showCalendar} onRequestClose={() => setShowCalendar(false)}>
      <View style={styles.calendarOverlay}>
        <View style={styles.calendarCard}>
          <View style={styles.calendarHeader}>
            <TouchableOpacity
              style={styles.calendarNavButton}
              onPress={() =>
                setCalendarMonth(
                  (previous) => new Date(previous.getFullYear(), previous.getMonth() - 1, 1)
                )
              }>
              <Text style={styles.buttonText}>{'<'}</Text>
            </TouchableOpacity>
            <Text style={styles.calendarTitle}>{monthTitle(calendarMonth)}</Text>
            <TouchableOpacity
              style={styles.calendarNavButton}
              onPress={() =>
                setCalendarMonth(
                  (previous) => new Date(previous.getFullYear(), previous.getMonth() + 1, 1)
                )
              }>
              <Text style={styles.buttonText}>{'>'}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((label) => (
              <Text key={label} style={styles.weekLabel}>
                {label}
              </Text>
            ))}
          </View>

          <View style={styles.daysGrid}>
            {calendarDays.map((dayValue, index) => {
              if (!dayValue) {
                return <View key={`empty-${index}`} style={styles.dayCellEmpty} />;
              }

              const selected = startDate === formatDate(dayValue);

              return (
                <TouchableOpacity
                  key={dayValue.toISOString()}
                  style={[styles.dayCell, selected && styles.dayCellActive]}
                  onPress={() => selectCalendarDate(dayValue)}>
                  <Text style={styles.dayLabel}>{dayValue.getDate()}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity style={styles.closeCalendarButton} onPress={() => setShowCalendar(false)}>
            <Text style={styles.buttonText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  container: {
    flexGrow: 1,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 16,
    paddingTop: 28,
    paddingBottom: 24,
  },
  loaderContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loaderText: {
    color: '#ffffff',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    gap: 10,
  },
  pageTitle: {
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
  navBar: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  navButton: {
    flex: 1,
    backgroundColor: '#2d2d4d',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  navButtonActive: {
    backgroundColor: '#5b58ff',
  },
  accountCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    backgroundColor: '#17172a',
    borderRadius: 12,
    padding: 12,
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
    marginBottom: 6,
  },
  accountWarning: {
    color: '#ffd27a',
    fontSize: 12,
    marginBottom: 8,
  },
  accountActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  accountActionButton: {
    flex: 1,
  },
  primaryButton: {
    backgroundColor: '#5b58ff',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  secondaryButton: {
    backgroundColor: '#287d5a',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cycleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  cycleButton: {
    flex: 1,
    backgroundColor: '#2d2d4d',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  cycleButtonActive: {
    backgroundColor: '#5b58ff',
  },
  buttonDisabled: {
    opacity: 0.7,
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
  syncWarningText: {
    marginBottom: 12,
    fontSize: 14,
    color: '#ffd27a',
  },
  summaryCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    backgroundColor: '#17172a',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  summaryTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },
  summaryText: {
    color: '#c7c7d1',
    marginBottom: 4,
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 10,
  },
  formCard: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 12,
    marginBottom: 14,
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
  dateButton: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 10,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 12,
  },
  dateButtonText: {
    color: '#fff',
  },
  dateButtonPlaceholder: {
    color: '#8a8aa3',
  },
  calendarOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  calendarCard: {
    width: '100%',
    maxWidth: 380,
    borderWidth: 1,
    borderColor: '#2d2d4d',
    borderRadius: 12,
    backgroundColor: '#17172a',
    padding: 12,
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  calendarTitle: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  calendarNavButton: {
    backgroundColor: '#2d2d4d',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  weekLabel: {
    flex: 1,
    textAlign: 'center',
    color: '#a0a0a0',
    fontSize: 12,
    fontWeight: '700',
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  dayCell: {
    width: '14.285%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 6,
  },
  dayCellEmpty: {
    width: '14.285%',
    paddingVertical: 8,
  },
  dayCellActive: {
    backgroundColor: '#5b58ff',
  },
  dayLabel: {
    color: '#ffffff',
    fontWeight: '600',
  },
  closeCalendarButton: {
    backgroundColor: '#2d2d4d',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  cancelButton: {
    marginTop: 10,
    backgroundColor: '#3a2a3d',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#ffb3b3',
    fontWeight: '700',
  },
  card: {
    borderWidth: 1,
    borderColor: '#2d2d4d',
    backgroundColor: '#17172a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cardTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  cardMeta: {
    color: '#c7c7d1',
    fontSize: 13,
    marginBottom: 2,
  },
  emptyText: {
    color: '#a0a0a0',
    fontSize: 14,
  },
});
