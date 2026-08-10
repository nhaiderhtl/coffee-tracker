import {
  FaMugHot, FaMugSaucer, FaIceCream, FaBlender, FaBolt, FaLeaf,
  FaTrophy, FaMedal, FaAward, FaCrown, FaStar, FaFire, FaBatteryFull,
  FaBullseye, FaListCheck, FaSun, FaCloudSun, FaMoon, FaClock, FaMap,
  FaHatWizard, FaChartLine, FaChartSimple, FaScaleBalanced, FaRotate,
  FaSquare, FaRegSquare, FaUserSecret, FaShieldHalved, FaMask, FaDumbbell,
  FaHeart, FaRegHeart, FaSeedling, FaHashtag, FaHeartCrack,
  FaWandMagicSparkles, FaDiceTwo, FaDiceThree, FaCheck, FaCircleCheck,
  FaSkull, FaTriangleExclamation, FaUsers, FaCalendarDays, FaCamera,
  FaXmark, FaBookmark, FaRegBookmark, FaPlus, FaArrowRight, FaLock, FaTrash, FaRegCopy,
  FaLayerGroup, FaImages,
  FaChevronUp, FaChevronDown, FaGithub, FaGlobe, FaSpinner, FaBell,
  FaGem, FaRankingStar, FaSyringe, FaCircleInfo,
} from 'react-icons/fa6';
import type { IconType } from 'react-icons';

// Central icon registry. Every glyph in the UI resolves through here by a stable
// string key, so server data (badges/achievements/tasks/coffees) carries a
// semantic key — never an emoji — and the client owns the actual icon choice.
// See VALUES.md rule 0.5: no emojis anywhere except the user's avatar picker.
const ICONS: Record<string, IconType> = {
  // ── Coffee / drinks ──
  coffee: FaMugHot,
  milk: FaMugSaucer,
  'ice-cream': FaIceCream,
  blended: FaBlender,
  chocolate: FaMugHot,
  tea: FaLeaf,
  energy: FaBolt,

  // ── Rewards / rankings ──
  trophy: FaTrophy,
  medal: FaMedal,
  award: FaAward,
  crown: FaCrown,
  gem: FaGem,
  ranking: FaRankingStar,
  syringe: FaSyringe,
  star: FaStar,
  fire: FaFire,
  bolt: FaBolt,
  battery: FaBatteryFull,
  target: FaBullseye,
  list: FaListCheck,
  century: FaHashtag,
  seedling: FaSeedling,
  'chart-line': FaChartLine,
  chart: FaChartSimple,

  // ── Time of day ──
  sunrise: FaSun,
  afternoon: FaCloudSun,
  night: FaMoon,
  clock: FaClock,

  // ── Variety / misc catalog ──
  map: FaMap,
  hat: FaHatWizard,
  scale: FaScaleBalanced,
  loop: FaRotate,
  square: FaSquare,
  spy: FaUserSecret,
  shield: FaShieldHalved,
  mask: FaMask,
  dumbbell: FaDumbbell,
  heart: FaHeart,
  flatline: FaHeartCrack,
  sparkles: FaWandMagicSparkles,
  'dice-two': FaDiceTwo,
  'dice-three': FaDiceThree,

  // ── Status / UI chrome ──
  check: FaCheck,
  'check-circle': FaCircleCheck,
  info: FaCircleInfo,
  spinner: FaSpinner,
  'square-empty': FaRegSquare,
  skull: FaSkull,
  warning: FaTriangleExclamation,
  users: FaUsers,
  calendar: FaCalendarDays,
  camera: FaCamera,
  gallery: FaImages,
  close: FaXmark,
  sun: FaSun,
  moon: FaMoon,
  bookmark: FaBookmark,
  'bookmark-o': FaRegBookmark,
  lock: FaLock,
  trash: FaTrash,
  copy: FaRegCopy,
  posts: FaLayerGroup,
  'heart-o': FaRegHeart,
  plus: FaPlus,
  'arrow-right': FaArrowRight,
  'chevron-up': FaChevronUp,
  'chevron-down': FaChevronDown,
  github: FaGithub,
  globe: FaGlobe,
  bell: FaBell,
};

const FALLBACK: IconType = FaMugHot;

// Every registered icon key, for admin catalog autosuggest (issue #77). An
// unknown key still renders (FALLBACK), so this is a suggestion list, not a
// hard constraint.
export const ICON_KEYS = Object.keys(ICONS);

export function Icon({
  name, size, className, title,
}: {
  name: string | undefined;
  size?: number;
  className?: string;
  title?: string;
}) {
  const Cmp = (name && ICONS[name]) || FALLBACK;
  return <Cmp size={size} className={className} title={title} aria-hidden={title ? undefined : true} />;
}
