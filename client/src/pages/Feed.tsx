import { useNavigate } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { FeedList } from '../components/FeedList';
import { Icon } from '../components/Icon';

export function Feed() {
  const navigate = useNavigate();
  return (
    <div className="page feed-page">
      <AppHeader />
      <div className="feed-mode-bar">
        <button className="feed-mode-btn active">
          <Icon name="clock" size={15} /> Recent
        </button>
        <button className="feed-mode-btn" onClick={() => navigate('/hall-of-fame')}>
          <Icon name="trophy" size={15} /> Hall of Fame
        </button>
      </div>
      <FeedList
        queryKey={['feed']}
        endpoint="/feed"
        emptyIcon="coffee"
        emptyTitle="The pot’s empty"
        emptySub="Be the first — tap + to post a coffee and share it with everyone."
      />
    </div>
  );
}
