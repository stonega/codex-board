import { describe, expect, test } from 'bun:test';

import { getOnboardingDisplayStep } from '../../apps/web/src/App';

describe('web onboarding display steps', () => {
  test('starts with provider setup until parser settings are ready', () => {
    expect(getOnboardingDisplayStep(false, false)).toBe('provider');
    expect(getOnboardingDisplayStep(false, true)).toBe('provider');
  });

  test('shows language selection before the sync step', () => {
    expect(getOnboardingDisplayStep(true, false)).toBe('language');
  });

  test('shows sync after language is confirmed', () => {
    expect(getOnboardingDisplayStep(true, true)).toBe('sync');
  });
});
