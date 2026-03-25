export interface Variant {
  id: string;
  name: string;
  weight: number;
  is_control?: boolean;
  js?: string | null;
  css?: string | null;
}

export interface UrlRule {
  id: string;
  match_type: 'exact' | 'equals' | 'contains' | 'starts_with' | 'regex';
  value: string;
  action?: 'include' | 'exclude';
}

export interface Goal {
  id: string;
  goal_type: 'url_match' | 'click' | 'custom';
  value?: string;
  url_match_type?: string;
}

export interface TargetingRule {
  id: string;
  attribute: string;
  operator: string;
  value: string;
}

export interface GaConfig {
  measurement_id: string;
  dimension_name: string;
}

export interface ExperimentConfig {
  id: string;
  name: string;
  status: string;
  mode?: string;
  traffic_percentage?: number;
  variants: Variant[];
  url_rules?: UrlRule[];
  goals?: Goal[];
  targeting_rules?: TargetingRule[];
  ga?: GaConfig | null;
}

export interface ExposureEvent {
  type: 'exposure';
  experiment_id: string;
  variant_id: string;
  user_id: string;
  session_id?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ConversionEvent {
  type: 'conversion';
  experiment_id: string;
  variant_id: string;
  user_id: string;
  session_id?: string;
  goal_name: string;
  goal_value?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export type ABEvent = ExposureEvent | ConversionEvent;

export interface ABTestingConfig {
  projectKey?: string;
  /** @deprecated Use projectKey instead */
  clientKey?: string;
  apiHost: string;
  userId?: string;
  sessionId?: string;
  antiFlicker?: boolean;
  customAttributes?: Record<string, string>;
  cookieConsent?: 'required';
}

export interface ProjectInfo {
  id: string;
  domain: string;
  ga_dimension_name?: string | null;
}

export interface CachedConfig {
  experiments: ExperimentConfig[];
  project?: ProjectInfo;
  timestamp: number;
}

export interface TrackOptions {
  value?: number;
  metadata?: Record<string, unknown>;
}

declare global {
  interface Window {
    __ab_reveal?: () => void;
    __ab_loader_ran?: boolean;
    __ab_loader_cfg?: { pk: string; host: string };
    ABTesting?: typeof import('./index').ABTesting;
    getAntiFlickerSnippet?: typeof import('./anti-flicker').getAntiFlickerSnippet;
    gtag?: (...args: any[]) => void;
  }
}
