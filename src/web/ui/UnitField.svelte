<script lang="ts" module>
  let next = 0;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import {
    hoursText,
    moneyText,
    parseDay,
    parseHours,
    parseMoney,
    parsePercent,
    percentText,
  } from '../../shared/units';
  import { dayText } from '../../shared/domain';
  import { hoursLabel, moneyGrouped } from '../../shared/economics';

  // Typed value in human units; the bound value keeps the API's unit. An unreadable entry
  // blocks the form through native validity and is never sent as zero.
  let {
    label,
    kind,
    value = $bindable(),
    currency = 'BRL',
    hint = '',
    required = true,
    placeholder = kind === 'date' ? 'DD/MM/AAAA' : '',
    min = '',
    max = '',
  }: {
    label: string;
    kind: 'money' | 'percent' | 'hours' | 'date';
    value: string | number | undefined;
    currency?: string;
    hint?: string;
    required?: boolean;
    placeholder?: string;
    /** ISO limits of a date. */
    min?: string;
    max?: string;
  } = $props();

  const id = `unit-${++next}`;
  const parse = (raw: string, cur: string) =>
    kind === 'date'
      ? parseDay(raw, min, max)
      : kind === 'money'
        ? parseMoney(raw, cur)
        : kind === 'percent'
          ? parsePercent(raw)
          : parseHours(raw);
  const format = (v: string | number | undefined, cur: string) =>
    kind === 'date'
      ? dayText(v as string | undefined)
      : kind === 'money'
        ? moneyText(v as string | undefined, cur)
        : kind === 'percent'
          ? percentText(v as number | undefined)
          : hoursText(v as number | undefined);
  const blank = () => (kind === 'money' || kind === 'date' ? '' : undefined);

  let input = $state<HTMLInputElement>();
  let text = $state(untrack(() => format(value, currency)));
  let parsed = $derived(parse(text, currency));
  let error = $derived(parsed.ok ? '' : parsed.message);
  let preview = $derived.by(() => {
    if (!parsed.ok) return '';
    if (kind === 'money')
      return `= ${moneyGrouped(String(parsed.value), currency)}`;
    if (kind === 'hours')
      return `= ${hoursLabel(parsed.value as number)} (${parsed.value} min)`;
    return '';
  });
  // The text is the source of truth. The last value emitted tells a change made from
  // outside (filled from terms, loaded version, form reset) from this field's own.
  let emitted: unknown = untrack(() => value);
  $effect(() => {
    const current = value;
    untrack(() => {
      if (current === emitted) return;
      emitted = current;
      text = format(current, currency);
    });
  });
  // Typing or a currency change re-reads the text; what was typed is never rewritten.
  $effect(() => {
    const next = parsed.ok ? parsed.value : blank();
    input?.setCustomValidity(error);
    untrack(() => {
      if (next === value) return;
      emitted = next;
      value = next;
    });
  });
</script>

<div class="unit-field">
  <label for={id}>{label}</label>
  <input
    {id}
    bind:this={input}
    bind:value={text}
    {required}
    {placeholder}
    inputmode={kind === 'hours'
      ? 'text'
      : kind === 'date'
        ? 'numeric'
        : 'decimal'}
    autocomplete="off"
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={`${id}-note`}
  />
  <small id={`${id}-note`} class:field-error={!!error} aria-live="polite"
    >{error || preview || hint}</small
  >
</div>
