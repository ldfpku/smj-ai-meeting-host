"use client";

import React, {
  createContext,
  useReducer,
  useContext,
  ReactNode,
  Dispatch,
  useEffect,
  useState,
} from "react";
import {
  PlaygroundState,
  defaultSessionConfig,
  defaultPlaygroundState,
} from "@/data/playground-state";
import { playgroundStateHelpers } from "@/lib/playground-state-helpers";
import { ModelId, normalizeModelId } from "@/data/models";

import { Preset, defaultPresets } from "@/data/presets";

const LS_GEMINI_API_KEY_NAME = "GEMINI_API_KEY";
const LS_USER_PRESETS_KEY = "PG_USER_PRESETS";
const LS_SELECTED_PRESET_ID_KEY = "PG_SELECTED_PRESET_ID";

const presetStorageHelper = {
  getStoredPresets: (): Preset[] => {
    const storedPresets = localStorage.getItem(LS_USER_PRESETS_KEY);
    return storedPresets ? JSON.parse(storedPresets) : [];
  },
  setStoredPresets: (presets: Preset[]): void => {
    localStorage.setItem(LS_USER_PRESETS_KEY, JSON.stringify(presets));
  },
  getStoredSelectedPresetId: (): string => {
    const storedId = localStorage.getItem(LS_SELECTED_PRESET_ID_KEY);
    if (!storedId) return defaultPresets[0].id;
    // A preset that existed in an earlier build may since have been removed
    // (the playground shipped a set of unrelated demo presets that are gone).
    // Resolving to an unknown id leaves the app with no selected preset at all,
    // so fall back to the default rather than trusting localStorage blindly.
    const knownIds = [
      ...defaultPresets.map((p) => p.id),
      ...presetStorageHelper.getStoredPresets().map((p) => p.id),
    ];
    return knownIds.includes(storedId) ? storedId : defaultPresets[0].id;
  },
  setStoredSelectedPresetId: (presetId: string | null): void => {
    if (presetId !== null) {
      localStorage.setItem(LS_SELECTED_PRESET_ID_KEY, presetId);
    } else {
      localStorage.removeItem(LS_SELECTED_PRESET_ID_KEY);
    }
  },
};

// Define action types and payloads
type Action =
  | {
    type: "SET_SESSION_CONFIG";
    payload: Partial<PlaygroundState["sessionConfig"]>;
  }
  | { type: "SET_API_KEY"; payload: string | null }
  | { type: "SET_GEMINI_KEY_FROM_ENV"; payload: boolean }
  | { type: "SET_INSTRUCTIONS"; payload: string }
  | { type: "SET_USER_PRESETS"; payload: Preset[] }
  | { type: "SET_SELECTED_PRESET_ID"; payload: string | null }
  | { type: "SAVE_USER_PRESET"; payload: Preset }
  | { type: "DELETE_USER_PRESET"; payload: string };

// Create the reducer function
function playgroundStateReducer(
  state: PlaygroundState,
  action: Action,
): PlaygroundState {
  switch (action.type) {
    case "SET_SESSION_CONFIG":
      return {
        ...state,
        sessionConfig: {
          ...state.sessionConfig,
          ...action.payload,
        },
      };
    case "SET_API_KEY":
      if (action.payload) {
        localStorage.setItem(LS_GEMINI_API_KEY_NAME, action.payload);
      } else {
        localStorage.removeItem(LS_GEMINI_API_KEY_NAME);
      }
      return {
        ...state,
        geminiAPIKey: action.payload,
      };
    case "SET_GEMINI_KEY_FROM_ENV":
      return {
        ...state,
        geminiKeyFromEnv: action.payload,
      };
    case "SET_INSTRUCTIONS":
      return {
        ...state,
        instructions: action.payload,
      };
    case "SET_USER_PRESETS":
      return {
        ...state,
        userPresets: action.payload,
      };
    case "SET_SELECTED_PRESET_ID":
      presetStorageHelper.setStoredSelectedPresetId(action.payload);

      let newState = {
        ...state,
        selectedPresetId: action.payload,
      };

      newState.instructions =
        playgroundStateHelpers.getSelectedPreset(newState)?.instructions || "";
      newState.sessionConfig =
        playgroundStateHelpers.getSelectedPreset(newState)?.sessionConfig ||
        defaultSessionConfig;
      return newState;
    case "SAVE_USER_PRESET":
      const updatedPresetsAdd = state.userPresets.map((preset) =>
        preset.id === action.payload.id ? action.payload : preset,
      );
      if (
        !updatedPresetsAdd.some((preset) => preset.id === action.payload.id)
      ) {
        updatedPresetsAdd.push(action.payload);
      }
      presetStorageHelper.setStoredPresets(updatedPresetsAdd);
      return {
        ...state,
        userPresets: updatedPresetsAdd,
      };
    case "DELETE_USER_PRESET":
      const updatedPresetsDelete = state.userPresets.filter(
        (preset: Preset) => preset.id !== action.payload,
      );
      presetStorageHelper.setStoredPresets(updatedPresetsDelete);
      return {
        ...state,
        userPresets: updatedPresetsDelete,
      };
    default:
      return state;
  }
}

// Update the context type
interface PlaygroundStateContextProps {
  pgState: PlaygroundState;
  dispatch: Dispatch<Action>;
  helpers: typeof playgroundStateHelpers;
  showAuthDialog: boolean;
  setShowAuthDialog: React.Dispatch<React.SetStateAction<boolean>>;
}

// Create the context
const PlaygroundStateContext = createContext<
  PlaygroundStateContextProps | undefined
>(undefined);

// Create a custom hook to use the global state
export const usePlaygroundState = (): PlaygroundStateContextProps => {
  const context = useContext(PlaygroundStateContext);
  if (!context) {
    throw new Error(
      "usePlaygroundState must be used within a PlaygroundStateProvider",
    );
  }
  return context;
};

// Create the provider component
interface PlaygroundStateProviderProps {
  children: ReactNode;
}

export const PlaygroundStateProvider = ({
  children,
}: PlaygroundStateProviderProps) => {
  const [state, dispatch] = useReducer(
    playgroundStateReducer,
    defaultPlaygroundState,
  );
  const [showAuthDialog, setShowAuthDialog] = useState(false);

  useEffect(() => {
    const storedKey = localStorage.getItem(LS_GEMINI_API_KEY_NAME);
    if (storedKey && storedKey.length >= 1) {
      dispatch({ type: "SET_API_KEY", payload: storedKey });
    } else {
      dispatch({ type: "SET_API_KEY", payload: null });
      // 服务端 .env.local 里可能已配置 GEMINI_API_KEY；配置了就不必打扰用户填写。
      // 密钥本身不会下发到浏览器，这里只拿一个布尔值。
      fetch("/api/gemini-status")
        .then((r) => (r.ok ? r.json() : { configured: false }))
        .then((d) => {
          if (d?.configured) {
            dispatch({ type: "SET_GEMINI_KEY_FROM_ENV", payload: true });
          } else {
            setShowAuthDialog(true);
          }
        })
        .catch(() => setShowAuthDialog(true));
    }

    // Load presets from localStorage
    const storedPresets = localStorage.getItem(LS_USER_PRESETS_KEY);
    let userPresets = storedPresets ? JSON.parse(storedPresets) : [];

    // Validate and fix invalid model IDs in stored presets
    userPresets = userPresets.map((preset: Preset) => {
      // Check if the preset has an invalid model ID
      if (!Object.values(ModelId).includes(preset.sessionConfig.model as ModelId)) {
        return {
          ...preset,
          sessionConfig: {
            ...preset.sessionConfig,
            model: defaultSessionConfig.model,
          },
        };
      }
      return preset;
    });

    // Save cleaned presets back to storage
    if (userPresets.length > 0) {
      presetStorageHelper.setStoredPresets(userPresets);
    }

    dispatch({ type: "SET_USER_PRESETS", payload: userPresets });

    // Read the URL
    const urlData = playgroundStateHelpers.decodeFromURLParams(
      window.location.search,
    );

    if (urlData.state.selectedPresetId) {
      const defaultPreset = playgroundStateHelpers
        .getDefaultPresets()
        .find((preset) => preset.id === urlData.state.selectedPresetId);

      if (defaultPreset) {
        dispatch({ type: "SET_SELECTED_PRESET_ID", payload: defaultPreset.id });
        // Don't clear the URL for default presets
        return;
      }

      // Handle non-default preset from URL
      if (urlData.preset && urlData.preset.name) {
        const newPreset: Preset = {
          id: urlData.state.selectedPresetId,
          name: urlData.preset.name || "分享的预设",
          description: urlData.preset.description,
          instructions: urlData.state.instructions || "",
          // 分享链接只带与默认值不同的字段，且可能指向已下线的模型
          sessionConfig: {
            ...defaultSessionConfig,
            ...urlData.state.sessionConfig,
            model: normalizeModelId(urlData.state.sessionConfig?.model),
          },
          defaultGroup: undefined,
        };

        const updatedUserPresets = [...userPresets, newPreset];
        presetStorageHelper.setStoredPresets(updatedUserPresets);
        dispatch({ type: "SET_USER_PRESETS", payload: updatedUserPresets });
        dispatch({ type: "SET_SELECTED_PRESET_ID", payload: newPreset.id });
      }

      // Clear the URL for non-default presets
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  return (
    <PlaygroundStateContext.Provider
      value={{
        pgState: state,
        dispatch,
        helpers: playgroundStateHelpers,
        showAuthDialog,
        setShowAuthDialog,
      }}
    >
      {children}
    </PlaygroundStateContext.Provider>
  );
};
