/**
 * 通用底部弹层封装（BottomSheet）
 * 基于 RN Modal 的半屏弹层：遮罩 + 内容容器 + 顶部拖拽把手。
 * 支持点击遮罩关闭与下滑手势关闭（PanResponder + Animated 过渡动画）。
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettingsStore } from '@/store/useSettingsStore';
import { getColors, PAGE_TITLE_FONT_SIZE } from '@/theme';

export interface BottomSheetProps {
  /** 是否可见 */
  visible: boolean;
  /** 关闭回调（点击遮罩 / 下滑 / 关闭按钮触发） */
  onClose: () => void;
  /** 弹层标题（可选） */
  title?: string;
  /** 弹层内容 */
  children: React.ReactNode;
  /** 内容区高度（默认 380） */
  height?: number;
}

/** 下滑多少 px 触发关闭 */
const CLOSE_THRESHOLD = 80;
/** 下滑阻尼系数 */
const DRAG_DAMPING = 0.45;

function BottomSheetInner({
  visible,
  onClose,
  title,
  children,
  height = 380,
}: BottomSheetProps): React.JSX.Element | null {
  const theme = useSettingsStore((s) => s.theme);
  const colors = getColors(theme);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  /** 弹层 Y 轴偏移（用于下滑手势动画） */
  const translateY = useRef(new Animated.Value(0)).current;
  /** 下滑距离记录（PanResponder 手势结束时判断是否关闭） */
  const dragDistance = useRef(0);

  // 打开时重置位移
  useEffect(() => {
    if (visible) {
      translateY.setValue(0);
      dragDistance.current = 0;
    }
  }, [visible, translateY]);

  /** 恢复弹层位置 */
  const snapBack = useCallback(() => {
    Animated.spring(translateY, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 4,
    }).start();
  }, [translateY]);

  /** 下滑手势 */
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_evt, gesture) => {
          dragDistance.current = Math.max(0, gesture.dy);
          translateY.setValue(dragDistance.current * DRAG_DAMPING);
        },
        onPanResponderRelease: () => {
          if (dragDistance.current > CLOSE_THRESHOLD) {
            Animated.timing(translateY, {
              toValue: height,
              duration: 180,
              useNativeDriver: true,
            }).start(onClose);
          } else {
            snapBack();
          }
          dragDistance.current = 0;
        },
        onPanResponderTerminate: snapBack,
      }),
    [height, onClose, snapBack, translateY],
  );

  const themedStyles = useMemo(
    () => createThemedStyles(colors, height, insets.bottom),
    [colors, height, insets.bottom],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={themedStyles.overlayWrap}>
        {/* 遮罩：点击关闭 */}
        <Pressable style={themedStyles.mask} onPress={onClose} />
        {/* 弹层主体 */}
        <Animated.View
          style={[
            themedStyles.sheet,
            { transform: [{ translateY }], width },
          ]}
        >
          <View style={themedStyles.handleArea} {...panResponder.panHandlers}>
            <View style={themedStyles.handle} />
            {title ? <Text style={themedStyles.title}>{title}</Text> : null}
          </View>
          <View style={themedStyles.content}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function createThemedStyles(
  colors: ReturnType<typeof getColors>,
  height: number,
  bottomInset: number,
) {
  return StyleSheet.create({
    overlayWrap: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    mask: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.overlay,
    },
    sheet: {
      height,
      paddingBottom: Math.max(bottomInset, 12),
      backgroundColor: colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      overflow: 'hidden',
    },
    handleArea: {
      alignItems: 'center',
      paddingTop: 10,
      paddingBottom: 6,
    },
    handle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: 8,
    },
    title: {
      fontSize: PAGE_TITLE_FONT_SIZE,
      fontWeight: '600',
      color: colors.text,
      paddingHorizontal: 20,
      textAlign: 'center',
    },
    content: {
      flex: 1,
    },
  });
}

/** 通用底部弹层 */
export const BottomSheet = memo(BottomSheetInner);

export default BottomSheet;
