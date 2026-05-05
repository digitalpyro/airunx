/**
 * Tools module - Language detection and tool registry
 */

export {
  detectProjectLanguage,
  detectProjectLanguageWithDetails,
  validatePHPProject,
  isPHPProject,
  isTypeScriptProject,
  isJavaScriptProject,
  getSupportedLanguages,
  isLanguageSupported,
  type LanguageDetectionResult,
  type PHPProjectValidation,
} from './language-detector.js';

export {
  getToolsForLanguage,
  getToolForLanguage,
  getToolCommand,
  getToolConfigFile,
  hasToolForLanguage,
  getRegisteredLanguages,
  getRegisteredToolTypes,
  mapGenericToolToType,
  resolveGenericTool,
  PHP_TOOLS,
  TYPESCRIPT_TOOLS,
  JAVASCRIPT_TOOLS,
} from './tool-registry.js';
