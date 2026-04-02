export interface Variant {
  id: string;
  name: string;
  weight: number;
  is_control?: boolean;
  index?: number;
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
  sequence_number?: number | null;
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

export type ABEvent = ExposureEvent | ConversionEvent | HeatmapClickEvent | HeatmapScrollEvent | HeatmapFormEvent;

export interface HeatmapClickEvent {
  type: 'heatmap_click';
  experiment_id?: string;
  variant_id?: string;
  user_id: string;
  session_id?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface HeatmapScrollEvent {
  type: 'heatmap_scroll';
  experiment_id?: string;
  variant_id?: string;
  user_id: string;
  session_id?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface HeatmapFormEvent {
  type: 'heatmap_form';
  experiment_id?: string;
  variant_id?: string;
  user_id: string;
  session_id?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface GrowthConfig {
  projectKey?: string;
  apiHost: string;
  userId?: string;
  sessionId?: string;
  antiFlicker?: boolean;
  customAttributes?: Record<string, string>;
  cookieConsent?: 'required';
  heatmaps?: boolean;
  surveys?: boolean | SurveyConfig;
}

export interface SurveyConfig {
  teamId?: string;
}

export interface HeatmapUrlRule {
  match_type: string;
  value: string;
}

export interface ProjectInfo {
  id: string;
  domain: string;
  ga_dimension_name?: string | null;
  heatmap_all_pages_enabled?: boolean;
  form_analytics_all_forms_enabled?: boolean;
  heatmaps_enabled?: boolean;
  surveys_enabled?: boolean;
}

export interface CachedConfig {
  experiments: ExperimentConfig[];
  project?: ProjectInfo;
  heatmapConfigs?: Array<{ capture_mode: string; url_rules: HeatmapUrlRule[] }>;
  formAnalyticsConfigs?: Array<{ capture_mode: string; url_rules: HeatmapUrlRule[]; form_selectors?: string[] }>;
  timestamp: number;
}

export interface TrackOptions {
  value?: number;
  metadata?: Record<string, unknown>;
}

export interface SurveyTrigger {
  type: 'pageLoad' | 'exitIntent' | 'scrollDepth' | 'clickElement' | 'code' | 'pageUrl';
  delay?: number;
  urlPattern?: string;
  urlMatch?: string;
  cssSelector?: string;
  actionName?: string;
  triggerOnRouteChange?: boolean;
}

export interface SurveyTargetingAttribute {
  key: string;
  operator: 'equals' | 'notEquals' | 'contains';
  value: string;
}

export interface SurveyTargeting {
  percentage?: number;
  frequency?: 'once' | 'oncePerSession' | 'always';
  recontactDays?: number;
  attributes?: SurveyTargetingAttribute[];
}

export interface SurveyQuestionOption {
  label: string;
}

export interface SurveyLogicRule {
  condition: string;
  value?: string;
  destination: string;
}

export interface SurveyQuestion {
  id: string;
  type: string;
  headline?: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  longAnswer?: boolean;
  inputType?: string;
  options?: SurveyQuestionOption[];
  ratingScale?: number;
  ratingShape?: string;
  lowLabel?: string;
  highLabel?: string;
  buttonLabel?: string;
  dismissible?: boolean;
  consentLabel?: string;
  logic?: SurveyLogicRule[];
}

export interface SurveyWelcomeCard {
  enabled: boolean;
  headline?: string;
  description?: string;
  buttonLabel?: string;
}

export interface SurveyThankYouCard {
  enabled: boolean;
  headline?: string;
  description?: string;
}

export interface SurveyStyling {
  position?: 'bottomRight' | 'bottomLeft' | 'center';
  brandColor?: string;
  bgColor?: string;
  textColor?: string;
  borderRadius?: string;
  progressBar?: boolean;
}

export interface SurveySettings {
  hideBackButton?: boolean;
}

export interface SurveyData {
  id: string;
  name: string;
  teamId?: string;
  projectDomain?: string;
  questions: SurveyQuestion[];
  triggers: SurveyTrigger[];
  targeting?: SurveyTargeting;
  welcomeCard?: SurveyWelcomeCard;
  thankYouCard?: SurveyThankYouCard;
  styling?: SurveyStyling;
  settings?: SurveySettings;
}

declare global {
  interface Window {
    __ab_reveal?: () => void;
    __gr_loader_ran?: boolean;
    __gr_loader_cfg?: { pk: string; host: string };
    GrowthRoadmaps?: typeof import('./index').GrowthRoadmaps;
    getAntiFlickerSnippet?: typeof import('./anti-flicker').getAntiFlickerSnippet;
    gtag?: (...args: any[]) => void;
  }
}
