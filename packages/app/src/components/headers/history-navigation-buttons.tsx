import { useCallback, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, type LucideProps } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "./header-toggle-button";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useRouteHistoryControls } from "@/navigation/route-history-controls";
import type { RouteHistoryDirection } from "@/navigation/route-history";
import type { ShortcutKey } from "@/utils/format-shortcut";

/** Header slots the pair occupies; placeholders reserve the same count. */
export const HISTORY_NAVIGATION_BUTTON_COUNT = 2;

const EMPTY_SHORTCUT_KEYS: ShortcutKey[] = [];
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);

function HistoryNavigationButton({
  direction,
  enabled,
  label,
  shortcutActionId,
  extraMutedIdleIcon,
  Icon,
}: {
  direction: RouteHistoryDirection;
  enabled: boolean;
  label: string;
  shortcutActionId: string;
  extraMutedIdleIcon: boolean;
  Icon: ComponentType<LucideProps & { uniProps: typeof mutedIconColorMapping }>;
}) {
  const navigate = useRouteHistoryControls((state) => state.navigate);
  const shortcutKeys = useShortcutKeys(shortcutActionId);
  const handlePress = useCallback(() => navigate?.(direction), [direction, navigate]);

  return (
    <HeaderToggleButton
      onPress={handlePress}
      disabled={!enabled || navigate === null}
      tooltipLabel={label}
      tooltipKeys={shortcutKeys?.[0] ?? EMPTY_SHORTCUT_KEYS}
      tooltipSide="bottom"
      testID={`history-${direction}-button`}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={extraMutedIdleIcon ? extraMutedIconColorMapping : mutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}

export function HistoryNavigationButtons({
  extraMutedIdleIcon = false,
}: {
  extraMutedIdleIcon?: boolean;
}) {
  const { t } = useTranslation();
  const canGoBack = useRouteHistoryControls((state) => state.canGoBack);
  const canGoForward = useRouteHistoryControls((state) => state.canGoForward);

  return (
    <>
      <HistoryNavigationButton
        direction="back"
        enabled={canGoBack}
        label={t("workspace.browser.controls.back")}
        shortcutActionId="history-back"
        extraMutedIdleIcon={extraMutedIdleIcon}
        Icon={ThemedArrowLeft}
      />
      <HistoryNavigationButton
        direction="forward"
        enabled={canGoForward}
        label={t("workspace.browser.controls.forward")}
        shortcutActionId="history-forward"
        extraMutedIdleIcon={extraMutedIdleIcon}
        Icon={ThemedArrowRight}
      />
    </>
  );
}
