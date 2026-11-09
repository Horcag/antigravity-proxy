export const CONTROL_OPERATIONS = new Set([
  'loadCodeAssist', 'onboardUser', 'fetchUserInfo', 'fetchAvailableModels',
  'retrieveUserQuota', 'retrieveUserQuotaSummary', 'fetchLicenses', 'fetchCredits',
  'listAgents', 'listInstances', 'listAuthorizedDevices', 'listRemoteRepositories',
  'listCloudAICompanionProjects', 'listModelConfigs', 'listExperiments',
  'fetchCodeCustomizationState', 'fetchAdminControls', 'getCodeAssistGlobalUserSetting',
  'fetchQuotaStatus', 'fetchConfig', 'fetchFromTrawlerCache',
]);

export function isNativeControlPlaneRequest(method: string, urlPath: string): boolean {
  const match = /^\/v1internal:([A-Za-z]+)(?:\?[^#]*)?$/.exec(urlPath);
  return method.toUpperCase() === 'POST' && Boolean(match && CONTROL_OPERATIONS.has(match[1]));
}

