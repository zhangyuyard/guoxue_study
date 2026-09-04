/**
 * @format
 * React Native 应用入口
 * - 必须最先引入 gesture-handler 以保证手势系统正确初始化
 * - 注册根组件 App
 */
import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
import App from '@/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
