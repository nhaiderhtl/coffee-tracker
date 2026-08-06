import { AppHeader } from '../components/AppHeader';
import { FeedList } from '../components/FeedList';

// Every coffee the user has posted, public and private, newest first. Private
// entries appear nowhere else in the app even though they count towards stats
// (issue #20).
export function MyPosts() {
  return (
    <div className="page feed-page">
      <AppHeader />
      <FeedList
        queryKey={['feed', 'mine']}
        endpoint="/feed/mine"
        emptyIcon="posts"
        emptyTitle="Your cup runneth under"
        emptySub="Everything you post — public or private — shows up here."
      />
    </div>
  );
}
