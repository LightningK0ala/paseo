import { useCallback } from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { CornerDownRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ThemedCornerDownRight = withUnistyles(CornerDownRight);
const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const TAB_KEYS = ["Tab"];

/**
 * Takes the suggested reply shown as the composer placeholder into the input.
 *
 * With a keyboard it shows the Tab keycap, the shortcut that does the same. On
 * touch it is a labelled chip next to the voice button, where the thumb already
 * is; nothing is hidden behind a gesture.
 */
export function ReplySuggestionButton({ onAccept }: { onAccept: () => void }) {
  const { t } = useTranslation();
  const hasKeyboard = useKeyboardShortcutsAvailable();
  const label = t("composer.replySuggestion.use");

  const renderContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) =>
      hasKeyboard ? (
        <Shortcut keys={TAB_KEYS} textStyle={hovered ? styles.keycapTextHovered : undefined} />
      ) : (
        <>
          <ThemedCornerDownRight size={ICON_SIZE.sm} uniProps={iconMutedMapping} />
          <Text style={styles.chipLabel}>{label}</Text>
        </>
      ),
    [hasKeyboard, label],
  );
  const buttonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      hasKeyboard ? styles.keycapButton : styles.chip,
      (hovered || pressed) && styles.chipActive,
    ],
    [hasKeyboard],
  );

  if (!hasKeyboard) {
    return (
      <Pressable
        onPress={onAccept}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="composer-reply-suggestion-accept"
        style={buttonStyle}
        hitSlop={8}
      >
        {renderContent}
      </Pressable>
    );
  }

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={onAccept}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="composer-reply-suggestion-accept"
        style={buttonStyle}
      >
        {renderContent}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  keycapButton: {
    height: 28,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  chipActive: {
    backgroundColor: theme.colors.surface2,
  },
  chipLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  keycapTextHovered: {
    color: theme.colors.foreground,
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
