-- Add call_frequency as an allowed signal type in owner_signals
-- This supports the Talkroute call log integration (sync:calls)

ALTER TABLE public.owner_signals
  DROP CONSTRAINT owner_signals_signal_type_check;

ALTER TABLE public.owner_signals
  ADD CONSTRAINT owner_signals_signal_type_check
  CHECK (signal_type IN (
    'phase_1',
    'phase_2',
    'phase_3',
    'trust_request',
    'engagement_drop',
    'bpm_slow_response',
    'call_frequency'
  ));
