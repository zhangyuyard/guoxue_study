/**
 * 多音字金标评测集（polyphoneGold）
 * 目标：以「经典语料名句 + 通行《古代汉语》注音」为准建立回归基线，
 * 逐条断言 PinyinService.annotate(text, 'full') 中目标字的读音与金标一致。
 *
 * - 金标读音以通行古汉语注音为准（宁可少而准）；
 * - 评测集必须与「当前实现下预期正确」对齐：若某条当前实现判错，
 *   则修正规则库（polyphone-rules.json）补齐 pattern，而不是放宽断言；
 * - 末尾输出基线准确率统计（passed/total）与失败明细（句子+字+期望+实际），
 *   供后续阶段（位置感知匹配 / 规则库扩容）量化改进。
 */
import { annotate } from '@/services/PinyinService';
import type { PinyinAnnotation } from '@/types';

/** 单条金标：text 含目标字 char 的句子，expected 为该字在此句的正确读音（带声调符号） */
interface GoldCase {
  text: string;
  char: string;
  expected: string;
}

const GOLD: GoldCase[] = [
  // ---------- 乐 ----------
  { text: '学而时习之，不亦说乎？有朋自远方来，不亦乐乎？', char: '乐', expected: 'lè' },
  { text: '礼乐皆得，谓之有德。', char: '乐', expected: 'yuè' },
  // ---------- 行 ----------
  { text: '三人行，必有我师焉。', char: '行', expected: 'xíng' },
  { text: '听其言而观其行。', char: '行', expected: 'xíng' },
  // ---------- 长 ----------
  { text: '长幼有序，朋友有信。', char: '长', expected: 'zhǎng' },
  { text: '天长地久。', char: '长', expected: 'cháng' },
  // ---------- 为 ----------
  { text: '为政以德，譬如北辰，居其所而众星共之。', char: '为', expected: 'wéi' },
  { text: '为人谋而不忠乎？', char: '为', expected: 'wéi' },
  { text: '故贵以身为天下，若可寄天下。', char: '为', expected: 'wèi' },
  // ---------- 好 ----------
  { text: '敏而好学，不耻下问。', char: '好', expected: 'hào' },
  { text: '妻子好合，如鼓瑟琴。', char: '好', expected: 'hǎo' },
  // ---------- 说 ----------
  { text: '学而时习之，不亦说乎？', char: '说', expected: 'yuè' },
  { text: '故说诗者，不以文害辞，不以辞害志。', char: '说', expected: 'shuō' },
  // ---------- 食 ----------
  { text: '谨食之，时而献焉。', char: '食', expected: 'sì' },
  { text: '狗彘食人食而不知检。', char: '食', expected: 'shí' },
  // ---------- 与 ----------
  { text: '与朋友交，言而有信。', char: '与', expected: 'yǔ' },
  { text: '吾不与祭，如不祭。', char: '与', expected: 'yù' },
  // ---------- 王 ----------
  { text: '文王既没，文不在兹乎？', char: '王', expected: 'wáng' },
  { text: '以德行仁者王。', char: '王', expected: 'wàng' },
  // ---------- 衣 / 冠 ----------
  { text: '衣锦尚絅，恶其文之著也。', char: '衣', expected: 'yì' },
  { text: '朝服衣冠，窥镜。', char: '衣', expected: 'yī' },
  { text: '朝服衣冠，窥镜。', char: '冠', expected: 'guān' },
  { text: '怒发冲冠，凭栏处、潇潇雨歇。', char: '冠', expected: 'guàn' },
  // ---------- 恶 ----------
  { text: '羞恶之心，义之端也。', char: '恶', expected: 'wù' },
  { text: '君子去仁，恶乎成名？', char: '恶', expected: 'wū' },
  // ---------- 数 ----------
  { text: '数罟不入洿池，鱼鳖不可胜食也。', char: '数', expected: 'cù' },
  { text: '百亩之田，勿夺其时，数口之家可以无饥矣。', char: '数', expected: 'shù' },
  // ---------- 传 ----------
  { text: '传不习乎？', char: '传', expected: 'chuán' },
  { text: '六艺经传皆通习之。', char: '传', expected: 'zhuàn' },
  // ---------- 朝 ----------
  { text: '朝闻道，夕死可矣。', char: '朝', expected: 'zhāo' },
  { text: '燕、赵、韩、魏闻之，皆朝于齐。', char: '朝', expected: 'cháo' },
  // ---------- 中 ----------
  { text: '刑罚不中，则民无所错手足。', char: '中', expected: 'zhòng' },
  { text: '中庸之为德也，其至矣乎。', char: '中', expected: 'zhōng' },
  // ---------- 重 ----------
  { text: '重岩叠嶂，隐天蔽日。', char: '重', expected: 'chóng' },
  { text: '君子不重则不威，学则不固。', char: '重', expected: 'zhòng' },
  { text: '晓看红湿处，花重锦官城。', char: '重', expected: 'zhòng' },
  // ---------- 教 ----------
  { text: '善人教民七年，亦可以即戎矣。', char: '教', expected: 'jiào' },
  { text: '不教而杀谓之虐。', char: '教', expected: 'jiāo' },
  // ---------- 度 ----------
  { text: '先自度其足，而置之其坐。', char: '度', expected: 'duó' },
  { text: '宁信度，无自信也。', char: '度', expected: 'dù' },
  // ---------- 乘 ----------
  { text: '千乘之国，摄乎大国之间。', char: '乘', expected: 'shèng' },
  { text: '虽有智慧，不如乘势。', char: '乘', expected: 'chéng' },
  // ---------- 观 ----------
  { text: '视其所以，观其所由，察其所安。', char: '观', expected: 'guān' },
  // ---------- 和 ----------
  { text: '礼之用，和为贵。', char: '和', expected: 'hé' },
  // ---------- 见 ----------
  { text: '见贤思齐焉，见不贤而内自省也。', char: '见', expected: 'jiàn' },
  { text: '风吹草低见牛羊。', char: '见', expected: 'xiàn' },
  // ---------- 空 ----------
  { text: '空山新雨后，天气晚来秋。', char: '空', expected: 'kōng' },
  // ---------- 得 ----------
  { text: '得道者多助，失道者寡助。', char: '得', expected: 'dé' },
  // ---------- 觉 ----------
  { text: '觉今是而昨非。', char: '觉', expected: 'jué' },
  // ---------- 强 ----------
  { text: '自胜者强。', char: '强', expected: 'qiáng' },
  // ---------- 塞 ----------
  { text: '塞下秋来风景异，衡阳雁去无留意。', char: '塞', expected: 'sài' },
  // ---------- 间 ----------
  { text: '起舞弄清影，何似在人间。', char: '间', expected: 'jiān' },
  { text: '遂与外人间隔。', char: '间', expected: 'jiàn' },
  // ---------- 假 ----------
  { text: '假舆马者，非利足也，而致千里。', char: '假', expected: 'jiǎ' },
  // ---------- 单 ----------
  { text: '单于夜遁逃。', char: '单', expected: 'chán' },
  // ---------- 相 / 将 ----------
  { text: '相看两不厌，只有敬亭山。', char: '相', expected: 'xiāng' },
  { text: '王侯将相宁有种乎！', char: '相', expected: 'xiàng' },
  { text: '王侯将相宁有种乎！', char: '将', expected: 'jiàng' },
  // ---------- 省 ----------
  { text: '吾日三省吾身。', char: '省', expected: 'xǐng' },
  // ---------- 降 ----------
  { text: '天将降大任于是人也。', char: '降', expected: 'jiàng' },
  // ---------- 应 ----------
  { text: '凡所应有，无所不有。', char: '应', expected: 'yìng' },
  // ---------- 兴 ----------
  { text: '越明年，政通人和，百废俱兴。', char: '兴', expected: 'xīng' },
  // ---------- 差 ----------
  { text: '参差荇菜，左右流之。', char: '差', expected: 'cī' },
  // ---------- 处 ----------
  { text: '择不处仁，焉得知？', char: '处', expected: 'chǔ' },
  // ---------- 当 / 发 ----------
  { text: '当春乃发生。', char: '当', expected: 'dāng' },
  { text: '当春乃发生。', char: '发', expected: 'fā' },
  { text: '怒发冲冠，凭栏处、潇潇雨歇。', char: '发', expected: 'fà' },
  // ---------- 分 ----------
  { text: '今天下三分，益州疲弊。', char: '分', expected: 'fēn' },
  // ---------- 服 ----------
  { text: '朝服衣冠，窥镜。', char: '服', expected: 'fú' },
  // ---------- 干 ----------
  { text: '干戈寥落四周星。', char: '干', expected: 'gān' },
  // ---------- 横 ----------
  { text: '凌云健笔意纵横。', char: '横', expected: 'héng' },
  // ---------- 会 ----------
  { text: '会当凌绝顶，一览众山小。', char: '会', expected: 'huì' },
  // ---------- 几 ----------
  { text: '问君能有几多愁。', char: '几', expected: 'jǐ' },
  // ---------- 将（进酒）----------
  { text: '将进酒，杯莫停。', char: '将', expected: 'qiāng' },
  { text: '将欲取之，必固与之。', char: '将', expected: 'jiāng' },
  // ---------- 尽 ----------
  { text: '臣尽节于陛下之日长。', char: '尽', expected: 'jìn' },
  // ---------- 卷 ----------
  { text: '有席卷天下，包举宇内，囊括四海之意。', char: '卷', expected: 'juǎn' },
  // ---------- 累 ----------
  { text: '九层之台，起于累土。', char: '累', expected: 'lěi' },
  // ---------- 埋 ----------
  { text: '埋骨何须桑梓地。', char: '埋', expected: 'mái' },
  // ---------- 磨 ----------
  { text: '宝剑锋从磨砺出，梅花香自苦寒来。', char: '磨', expected: 'mó' },
  // ---------- 宁 ----------
  { text: '非淡泊无以明志，非宁静无以致远。', char: '宁', expected: 'níng' },
  // ---------- 奇 ----------
  { text: '舟首尾长约八分有奇。', char: '奇', expected: 'jī' },
  // ---------- 切 ----------
  { text: '如切如磋，如琢如磨。', char: '切', expected: 'qiē' },
  // ---------- 曲 ----------
  { text: '曲则全，枉则直。', char: '曲', expected: 'qū' },
  // ---------- 任 ----------
  { text: '任重而道远。', char: '任', expected: 'rèn' },
  // ---------- 舍 ----------
  { text: '锲而不舍，金石可镂。', char: '舍', expected: 'shě' },
  { text: '客舍青青柳色新。', char: '舍', expected: 'shè' },
  // ---------- 熟 ----------
  { text: '无他，但手熟尔。', char: '熟', expected: 'shú' },
  // ---------- 丧 ----------
  { text: '三年之丧，齐疏之服。', char: '丧', expected: 'sāng' },
  // ---------- 属 ----------
  { text: '属予作文以记之。', char: '属', expected: 'zhǔ' },
  // ---------- 择 ----------
  { text: '择其善者而从之。', char: '择', expected: 'zé' },
  // ---------- 曾 ----------
  { text: '曾子曰：吾日三省吾身。', char: '曾', expected: 'zēng' },
  // ---------- 饮 ----------
  { text: '一箪食，一瓢饮，在陋巷。', char: '饮', expected: 'yǐn' },
  { text: '饮马长城窟，水寒伤马骨。', char: '饮', expected: 'yìn' },
  // ---------- 予 ----------
  { text: '予观夫巴陵胜状，在洞庭一湖。', char: '予', expected: 'yǔ' },
  // ---------- 燕 ----------
  { text: '旧时王谢堂前燕，飞入寻常百姓家。', char: '燕', expected: 'yàn' },
  { text: '燕、赵、韩、魏闻之，皆朝于齐。', char: '燕', expected: 'yān' },
  // ---------- 遗 ----------
  { text: '以光先帝遗德，恢弘志士之气。', char: '遗', expected: 'yí' },
  // ---------- 载 ----------
  { text: '载笑载言。', char: '载', expected: 'zài' },
  // ---------- 种 / 作 ----------
  { text: '其中往来种作，男女衣着，悉如外人。', char: '种', expected: 'zhòng' },
  { text: '其中往来种作，男女衣着，悉如外人。', char: '作', expected: 'zuò' },
  // ---------- 看 ----------
  { text: '晓看红湿处，花重锦官城。', char: '看', expected: 'kàn' },
  // ---------- 更 ----------
  { text: '欲穷千里目，更上一层楼。', char: '更', expected: 'gèng' },
  // ---------- pinyin-pro 语境判音（规则库外） ----------
  { text: '春风又绿江南岸。', char: '绿', expected: 'lǜ' },
  { text: '露从今夜白，月是故乡明。', char: '露', expected: 'lù' },
  { text: '夜来风雨声，花落知多少。', char: '雨', expected: 'yǔ' },
  { text: '门泊东吴万里船。', char: '泊', expected: 'bó' },
  { text: '少壮不努力，老大徒伤悲。', char: '少', expected: 'shào' },
  // ---------- 阶段3 扩容字金标 ----------
  { text: '浩浩汤汤，横无际涯。', char: '汤', expected: 'shāng' },
  { text: '烟笼寒水月笼沙。', char: '笼', expected: 'lǒng' },
  { text: '夜泊秦淮近酒家。', char: '泊', expected: 'bó' },
  { text: '期年之后，虽欲言，无可进者。', char: '期', expected: 'jī' },
  { text: '叶公好龙。', char: '叶', expected: 'yè' },
  { text: '默而识之，学而不厌。', char: '识', expected: 'zhì' },
  { text: '陟罚臧否，不宜异同。', char: '否', expected: 'pǐ' },
  { text: '一夫当关，万夫莫开。', char: '夫', expected: 'fū' },
  { text: '逝者如斯夫，不舍昼夜。', char: '夫', expected: 'fú' },
  { text: '可汗大点兵。', char: '汗', expected: 'hán' },
  { text: '但闻燕山胡骑鸣啾啾。', char: '骑', expected: 'jì' },
  { text: '六国互丧，率赂秦耶？', char: '率', expected: 'shuài' },
  { text: '参差荇菜，左右流之。', char: '参', expected: 'cēn' },
  { text: '用之则行，舍之则藏。', char: '藏', expected: 'cáng' },
  { text: '接天莲叶无穷碧，映日荷花别样红。', char: '荷', expected: 'hé' },
  { text: '都护铁衣冷难着。', char: '都', expected: 'dū' },
  { text: '独坐幽篁里，弹琴复长啸。', char: '弹', expected: 'tán' },
];

/** 取某字的注音项（取该字在句中的首次出现） */
function pinyinOf(anns: PinyinAnnotation[], char: string): string {
  const hit = anns.find((a) => a.char === char);
  if (!hit) {
    throw new Error(`未找到「${char}」的注音项`);
  }
  return hit.pinyin;
}

describe('多音字金标评测集', () => {
  /** 失败明细：句子 + 字 + 期望 + 实际（供量化改进） */
  const failures: string[] = [];
  let passed = 0;

  for (const c of GOLD) {
    const res = annotate(c.text, 'full');
    if (!res.success || !res.data) {
      failures.push(`[注音失败] ${c.text} | 字=${c.char} 期望=${c.expected} 错误=${res.error}`);
      continue;
    }
    try {
      const actual = pinyinOf(res.data, c.char);
      if (actual === c.expected) {
        passed++;
      } else {
        failures.push(`[判错] ${c.text} | 字=${c.char} 期望=${c.expected} 实际=${actual}`);
      }
    } catch (e) {
      failures.push(`[异常] ${c.text} | 字=${c.char} ${(e as Error).message}`);
    }
  }

  test('金标逐条通过（准确率 100%）', () => {
    // 基线准确率统计 + 失败明细（全绿时无失败行）
    console.info(
      `[polyphoneGold] 基线准确率：${passed}/${GOLD.length} = ` +
        `${((passed / GOLD.length) * 100).toFixed(1)}%`,
    );
    for (const f of failures) {
      console.info(`[polyphoneGold] ${f}`);
    }
    expect(failures).toEqual([]);
  });
});
