import { useNavigate } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { FeedList } from '../components/FeedList';
import { Icon } from '../components/Icon';

export function HallOfFame() {
  const navigate = useNavigate();
  return (
    <div className="page feed-page">
      <AppHeader />
      <div className="feed-mode-bar">
        <button className="feed-mode-btn" onClick={() => navigate('/')}>
          <Icon name="clock" size={15} /> Recent
        </button>
        <button className="feed-mode-btn active">
          <Icon name="trophy" size={15} /> Hall of Fame
        </button>
      </div>
      <FeedList
        queryKey={['hall-of-fame']}
        endpoint="/feed/hall-of-fame"
        emptyIcon="trophy"
        emptyTitle="No legends yet"
        emptySub="Posts from the last 30 days that earn enough likes appear here. Start liking!"
      />
    </div>
  );
}
