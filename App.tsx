/**
 * The screen.
 *
 * One list, one form, and the number people actually open the app for: who
 * owes whom. Everything shown here is derived from the operation log, so
 * what is on screen is exactly what would survive a sync.
 */

import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MoneyError, parseAmount, withSymbol } from './src/ui/money';
import { useLedger } from './src/ui/useLedger';

const SUGGESTED = ['riya', 'sam', 'dev'];

export default function App() {
  const ledger = useLedger();

  if (ledger.status === 'opening') {
    return (
      <View style={[styles.screen, styles.centred]}>
        <ActivityIndicator color={C.accent} />
        <Text style={styles.muted}>Opening your ledger…</Text>
        <StatusBar style="light" />
      </View>
    );
  }

  if (ledger.status === 'failed') {
    return (
      <View style={[styles.screen, styles.centred]}>
        <Text style={styles.title}>The ledger would not open</Text>
        <Text style={styles.muted}>{ledger.error}</Text>
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Header pending={ledger.pending} device={ledger.device} />

        {ledger.recovered && (
          <View style={[styles.banner, styles.bannerWarn]}>
            <Text style={styles.bannerText}>
              Some stored data could not be read and was set aside rather than deleted. Your
              ledger has started fresh; nothing was thrown away.
            </Text>
          </View>
        )}

        <Settlement transfers={ledger.transfers} balances={ledger.balances} />

        <AddExpense people={ledger.people} onAdd={ledger.addExpense} />

        <Text style={styles.sectionTitle}>
          {ledger.entries.length === 0
            ? 'No spending yet'
            : `${ledger.entries.length} ${ledger.entries.length === 1 ? 'entry' : 'entries'}`}
        </Text>

        {ledger.entries.map((entry) => (
          <Pressable
            key={entry.id}
            style={styles.row}
            onLongPress={() => ledger.removeExpense(entry.id)}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle}>{entry.description || 'Untitled'}</Text>
              <Text style={styles.rowMeta}>
                {entry.payer} paid · split {entry.participants.length}{' '}
                {entry.participants.length === 1 ? 'way' : 'ways'}
              </Text>
            </View>
            <Text style={styles.rowAmount}>{withSymbol(entry.amountMinor)}</Text>
          </Pressable>
        ))}

        {ledger.entries.length > 0 && (
          <Text style={styles.hint}>Long-press an entry to remove it.</Text>
        )}
      </ScrollView>
      <StatusBar style="light" />
    </KeyboardAvoidingView>
  );
}

function Header({ pending, device }: { pending: number; device: string }) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.brand}>tally</Text>
        <Text style={styles.muted}>Shared costs that work with no signal</Text>
      </View>
      <View style={styles.pill}>
        <View style={[styles.dot, pending > 0 ? styles.dotPending : styles.dotSynced]} />
        <Text style={styles.pillText}>{pending > 0 ? `${pending} to sync` : 'all synced'}</Text>
      </View>
      <Text style={styles.device} numberOfLines={1}>
        {device}
      </Text>
    </View>
  );
}

function Settlement({
  transfers,
  balances,
}: {
  transfers: { from: string; to: string; amountMinor: number }[];
  balances: [string, number][];
}) {
  if (balances.length === 0) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Settling up</Text>
      {transfers.map((transfer) => (
        <View key={`${transfer.from}-${transfer.to}`} style={styles.settleRow}>
          <Text style={styles.settleText}>
            <Text style={styles.strong}>{transfer.from}</Text> pays{' '}
            <Text style={styles.strong}>{transfer.to}</Text>
          </Text>
          <Text style={styles.settleAmount}>{withSymbol(transfer.amountMinor)}</Text>
        </View>
      ))}
      <View style={styles.balanceStrip}>
        {balances.map(([person, amount]) => (
          <Text key={person} style={styles.balanceChip}>
            {person} {amount > 0 ? '+' : ''}
            {withSymbol(amount)}
          </Text>
        ))}
      </View>
    </View>
  );
}

function AddExpense({
  people,
  onAdd,
}: {
  people: string[];
  onAdd: (expense: {
    description: string;
    amountMinor: number;
    payer: string;
    participants: string[];
  }) => Promise<void>;
}) {
  const roster = useMemo(() => [...new Set([...SUGGESTED, ...people])].sort(), [people]);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [payer, setPayer] = useState(roster[0] ?? 'riya');
  const [sharers, setSharers] = useState<string[]>(roster);
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = (person: string) =>
    setSharers((current) =>
      current.includes(person) ? current.filter((p) => p !== person) : [...current, person],
    );

  const submit = async () => {
    try {
      const amountMinor = parseAmount(amount);
      if (amountMinor === 0) throw new MoneyError('an expense of zero is not an expense');
      if (sharers.length === 0) throw new MoneyError('nobody is sharing this');
      await onAdd({
        description: description.trim() || 'Untitled',
        amountMinor,
        payer,
        participants: sharers,
      });
      setDescription('');
      setAmount('');
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not add that');
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Add an expense</Text>
      <TextInput
        style={styles.input}
        placeholder="What was it for?"
        placeholderTextColor={C.faint}
        value={description}
        onChangeText={setDescription}
      />
      <TextInput
        style={styles.input}
        placeholder="Amount, e.g. 1,200.50"
        placeholderTextColor={C.faint}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        inputMode="decimal"
      />

      <Text style={styles.label}>Paid by</Text>
      <View style={styles.chips}>
        {roster.map((person) => (
          <Pressable
            key={person}
            onPress={() => setPayer(person)}
            style={[styles.chip, payer === person && styles.chipOn]}
          >
            <Text style={[styles.chipText, payer === person && styles.chipTextOn]}>{person}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Split between</Text>
      <View style={styles.chips}>
        {roster.map((person) => (
          <Pressable
            key={person}
            onPress={() => toggle(person)}
            style={[styles.chip, sharers.includes(person) && styles.chipOn]}
          >
            <Text style={[styles.chipText, sharers.includes(person) && styles.chipTextOn]}>
              {person}
            </Text>
          </Pressable>
        ))}
      </View>

      {problem && <Text style={styles.error}>{problem}</Text>}

      <Pressable style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>Add expense</Text>
      </Pressable>
    </View>
  );
}

const C = {
  bg: '#0b1020',
  card: '#141b2f',
  line: '#223052',
  text: '#e8eefb',
  muted: '#93a3c4',
  faint: '#5f6f91',
  accent: '#6ea8fe',
  good: '#45d4a0',
  warn: '#ffc866',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  centred: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  content: {
    padding: 18,
    paddingTop: 64,
    paddingBottom: 56,
    gap: 16,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  header: { gap: 8 },
  brand: { color: C.text, fontSize: 30, fontWeight: '700', letterSpacing: -0.5 },
  title: { color: C.text, fontSize: 20, fontWeight: '600' },
  muted: { color: C.muted, fontSize: 13.5 },
  device: { color: C.faint, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    backgroundColor: C.card,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  pillText: { color: C.muted, fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotSynced: { backgroundColor: C.good },
  dotPending: { backgroundColor: C.warn },
  banner: { borderRadius: 12, padding: 12, borderWidth: 1 },
  bannerWarn: { backgroundColor: '#1d1708', borderColor: '#4a3c15' },
  bannerText: { color: '#ffd89b', fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: C.card,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '600' },
  sectionTitle: {
    color: C.muted,
    fontSize: 12.5,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginTop: 4,
  },
  input: {
    backgroundColor: C.bg,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 13,
    color: C.text,
    fontSize: 15,
  },
  label: { color: C.muted, fontSize: 12.5, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 13,
    backgroundColor: C.bg,
  },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipText: { color: C.muted, fontSize: 13 },
  chipTextOn: { color: '#06101f', fontWeight: '600' },
  button: {
    backgroundColor: C.accent,
    borderRadius: 11,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#06101f', fontWeight: '700', fontSize: 15 },
  error: { color: '#ff9a9a', fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.card,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 13,
    padding: 14,
  },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { color: C.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: C.muted, fontSize: 12.5 },
  rowAmount: { color: C.text, fontSize: 15.5, fontWeight: '700' },
  hint: { color: C.faint, fontSize: 12, textAlign: 'center' },
  settleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 5,
  },
  settleText: { color: C.muted, fontSize: 14 },
  strong: { color: C.text, fontWeight: '600' },
  settleAmount: { color: C.good, fontSize: 15, fontWeight: '700' },
  balanceStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 6,
    borderTopColor: C.line,
    borderTopWidth: 1,
    paddingTop: 11,
  },
  balanceChip: {
    color: C.muted,
    fontSize: 12,
    backgroundColor: C.bg,
    borderRadius: 7,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
});
