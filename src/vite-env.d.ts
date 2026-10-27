/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** "true" in the survey build; see src/config/surveyBuild.ts. */
    readonly VITE_SURVEY_BUILD?: string;
}

declare module "virtual:pwa-register" {
    export function registerSW(options?: {
        immediate?: boolean;
        onNeedRefresh?: () => void;
        onOfflineReady?: () => void;
    }): (reloadPage?: boolean) => Promise<void>;
}
