import type { Account, DraftRow } from './types';

interface Mention { account: Account; name: string; at: number }
export function accountMentions(text: string, accounts: Account[]): Mention[] {
  const found = accounts.flatMap(account => [account.name, ...account.aliases].flatMap(name => {
    const at = text.indexOf(name); return at < 0 ? [] : [{ account, name, at }];
  })).sort((a, b) => b.name.length - a.name.length);
  const kept: Mention[] = [];
  for (const mention of found) if (!kept.some(other => mention.at >= other.at && mention.at + mention.name.length <= other.at + other.name.length)) kept.push(mention);
  return kept.filter((m, index, list) => list.findIndex(x => x.account.id === m.account.id) === index);
}
/** Configured account names/aliases are evidence; a model guess and a default are not. */
export function routeNamedAccount(row: DraftRow, accounts: Account[], evidence = row.sourceQuote): void {
  const mentions = accountMentions(evidence, accounts).filter(m => m.account.kind === 'asset');
  const before = (m: Mention) => evidence.slice(Math.max(0, m.at - 12), m.at);
  const after = (m: Mention) => evidence.slice(m.at + m.name.length, m.at + m.name.length + 16);
  const sources = mentions.filter(m => /(?:从|用|由|把)\s*$/.test(before(m)));
  const destinations = mentions.filter(m => /(?:到|往|向|给|转入)\s*$/.test(before(m)) || /^(?:账户)?(?:里)?\s*(?:充值|充(?:了|钱|入|进|上|\s*[零〇一二两三四五六七八九十百千万\d]))/.test(after(m)));
  const recharge = /充值|充(?:了|钱|入|进|上|\s*[零〇一二两三四五六七八九十百千万\d])/.test(evidence) && destinations.length === 1;
  if (recharge && ['income', 'expense', 'transfer', 'unknown'].includes(row.kind)) {
    const target = destinations[0].account;
    row.kind = 'transfer'; row.accountId = ''; row.categoryId = ''; row.relatedId = ''; row.debtAccountId = ''; row.cost = null; row.usedDefault = false;
    row.toAccountId = target.id;
    const source = sources.filter(m => m.account.id !== target.id);
    row.fromAccountId = source.length === 1 ? source[0].account.id : '';
    if (!row.fromAccountId) row.issues.push('充值属于内部转账，转出账户未说清楚，请补选');
    return;
  }
  if (['transfer', 'lend', 'collect'].includes(row.kind)) {
    if (sources.length === 1) row.fromAccountId = sources[0].account.id;
    if (destinations.length === 1) row.toAccountId = destinations[0].account.id;
    return;
  }
  if (!['income', 'expense', 'refund'].includes(row.kind) || !mentions.length) return;
  const explicit = sources.length === 1 ? sources : mentions;
  if (explicit.length === 1) { row.accountId = explicit[0].account.id; row.usedDefault = false; }
  else { row.accountId = ''; row.usedDefault = false; row.issues.push('原文提到多个账户，请明确本笔使用的账户'); }
}
