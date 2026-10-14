// @ts-nocheck
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { RekognitionService } from '../common/rekognition.service';
import { S3Service } from '../common/s3.service';
import { TextModerationService } from '../common/text-moderation.service';
import { Circle, CirclePost } from '../circles/circle.entity';
import { ActorAuthService } from '../shared/auth/actor-auth.service';
import { createDomainEvent, DOMAIN_EVENT_TYPES } from '../shared/contracts/domain-events';
import { AdvertisementPlacementService } from '../shared/data-access/advertisement-placement.service';
import { UserAccountService } from '../shared/data-access/user-account.service';
import { EventPublisherService } from '../shared/events/event-publisher.service';
import { USER_BADGE_DEFINITIONS, calculateEngagementScore, computeUserRating, evaluateUserBadges } from './user-badges';
import { WallPost } from './wall.entity';
import { WallViewEvent } from './wall-view-event.entity';

@Injectable()
export class WallService {
  private readonly logger = new Logger(WallService.name);

  constructor(
    @InjectModel(WallPost.name) private readonly wallPostModel: Model<any>,
    @InjectModel(WallViewEvent.name) private readonly wallViewEventModel: Model<any>,
    @InjectModel(Circle.name) private readonly circleModel: Model<any>,
    @InjectModel(CirclePost.name) private readonly circlePostModel: Model<any>,
    private readonly s3Service: S3Service,
    private readonly rekognitionService: RekognitionService,
    private readonly textModerationService: TextModerationService,
    private readonly userAccountService: UserAccountService,
    private readonly advertisementPlacementService: AdvertisementPlacementService,
    private readonly actorAuthService: ActorAuthService,
    private readonly eventPublisher: EventPublisherService,
  ) {}

  // Called by user-service whenever a user changes their avatar and/or name,
  // so existing posts/comments (which store a denormalized authorAvatar /
  // authorName for fast feed reads) reflect the update instead of staying
  // frozen at post time. Only the fields actually passed get updated.
  async syncAuthorProfileEverywhere(userId: string, changes: { avatarUrl?: string; authorName?: string }) {
    const postSet: Record<string, string> = {};
    if (changes.avatarUrl !== undefined) postSet.authorAvatar = changes.avatarUrl;
    if (changes.authorName !== undefined) postSet.authorName = changes.authorName;
    if (Object.keys(postSet).length === 0) return { ok: true };

    const commentSet: Record<string, string> = {};
    if (changes.avatarUrl !== undefined) commentSet['comments.$[c].authorAvatar'] = changes.avatarUrl;
    if (changes.authorName !== undefined) commentSet['comments.$[c].authorName'] = changes.authorName;

    const imageCommentSet: Record<string, string> = {};
    if (changes.avatarUrl !== undefined) imageCommentSet['imageEngagement.$[].comments.$[c].authorAvatar'] = changes.avatarUrl;
    if (changes.authorName !== undefined) imageCommentSet['imageEngagement.$[].comments.$[c].authorName'] = changes.authorName;

    await Promise.all([
      this.wallPostModel.updateMany({ userId }, { $set: postSet }).exec(),
      this.wallPostModel
        .updateMany(
          { 'comments.userId': userId },
          { $set: commentSet },
          { arrayFilters: [{ 'c.userId': userId }] },
        )
        .exec(),
      this.wallPostModel
        .updateMany(
          { 'imageEngagement.comments.userId': userId },
          { $set: imageCommentSet },
          { arrayFilters: [{ 'c.userId': userId }] },
        )
        .exec(),
      this.circlePostModel.updateMany({ userId }, { $set: postSet }).exec(),
    ]);
    return { ok: true };
  }

    getNumericEnv(name, fallback) {
        const raw = Number(process.env[name]);
        return Number.isFinite(raw) ? raw : fallback;
    }
    isRankingDebugEnabled() {
        return (String(process.env.WALL_RANKING_DEBUG || 'false').toLowerCase() === 'true');
    }
    getRankingConfig() {
        return {
            viewsWeight: this.getNumericEnv('WALL_RANK_VIEWS_WEIGHT', 0.2),
            reactionsWeight: this.getNumericEnv('WALL_RANK_REACTIONS_WEIGHT', 4),
            commentsWeight: this.getNumericEnv('WALL_RANK_COMMENTS_WEIGHT', 5),
            sharesWeight: this.getNumericEnv('WALL_RANK_SHARES_WEIGHT', 7),
            followersWeight: this.getNumericEnv('WALL_RANK_FOLLOWERS_WEIGHT', 3),
            followedAuthorBoost: this.getNumericEnv('WALL_RANK_FOLLOWED_AUTHOR_BOOST', 18),
            affinityAuthorBoost: this.getNumericEnv('WALL_RANK_AFFINITY_AUTHOR_BOOST', 14),
            affinityTagWeight: this.getNumericEnv('WALL_RANK_AFFINITY_TAG_WEIGHT', 4),
            fatiguedAuthorPenalty: this.getNumericEnv('WALL_RANK_FATIGUED_AUTHOR_PENALTY', 16),
            seenPostPenalty: this.getNumericEnv('WALL_RANK_SEEN_POST_PENALTY', 28),
            freshnessReactionWeight: this.getNumericEnv('WALL_RANK_FRESH_REACTIONS_WEIGHT', 2),
            freshnessCommentWeight: this.getNumericEnv('WALL_RANK_FRESH_COMMENTS_WEIGHT', 3),
            freshnessShareWeight: this.getNumericEnv('WALL_RANK_FRESH_SHARES_WEIGHT', 4),
            freshnessDecayHours: this.getNumericEnv('WALL_RANK_FRESHNESS_DECAY_HOURS', 24),
            timeDecayDivisorHours: this.getNumericEnv('WALL_RANK_TIME_DECAY_DIVISOR_HOURS', 6),
        };
    }
    getActorIdFromAuth(authorization) {
        return this.actorAuthService.getActorIdFromAuth(authorization);
    }
    async createPresignedUpload(actorId, dto) {
        const safeName = dto.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const key = `wall/${actorId}/${Date.now()}-${randomUUID()}-${safeName}`;
        this.logger.log(`[presign] actorId=${actorId} file=${dto.fileName} type=${dto.contentType} mediaType=${dto.mediaType ?? 'unknown'} key=${key}`);
        return this.s3Service.createPresignedUpload(key, dto.contentType);
    }
    normalizeTag(raw) {
        if (!raw)
            return null;
        const trimmed = raw.trim().replace(/^#+/, '').toLowerCase();
        if (!trimmed)
            return null;
        if (!/^[a-z0-9_]{1,50}$/.test(trimmed))
            return null;
        return trimmed;
    }
    normalizeTags(tags) {
        if (!tags?.length)
            return [];
        return Array.from(new Set(tags
            .map((tag) => this.normalizeTag(tag))
            .filter((tag) => Boolean(tag))));
    }
    extractHashtags(caption) {
        if (!caption?.trim())
            return [];
        const matches = caption.match(/#[A-Za-z0-9_]{1,50}/g) || [];
        return this.normalizeTags(matches.map((tag) => tag.slice(1)));
    }
    resolvePostTags(caption, explicitTags) {
        return Array.from(new Set([
            ...this.extractHashtags(caption),
            ...this.normalizeTags(explicitTags),
        ]));
    }
    getBadgeCatalog() {
        return USER_BADGE_DEFINITIONS;
    }
    normalizePostPayload(post) {
        const shares: any[] = Array.isArray(post.shares) ? post.shares : [];
        // Latest sharer first, up to 3 names, only entries that recorded a name
        const recentSharers: string[] = shares
            .slice(-3)
            .reverse()
            .map((s: any) => s.sharedByName as string | undefined)
            .filter((n): n is string => Boolean(n));

        const normalized = {
            ...post,
            recentSharers,
            sourceType: String(post.sourceType || 'wall')
                .trim()
                .toLowerCase() === 'circle'
                ? 'circle'
                : 'wall',
            circleId: post.circleId?.toString().trim() || null,
            circleName: post.circleName?.toString().trim() || null,
            circleAvatarUrl: post.circleAvatarUrl?.toString().trim() || null,
            circleVisibility: post.circleVisibility?.toString().trim() || null,
            circlePostId: post.circlePostId?.toString().trim() || null,
            tags: Array.isArray(post.tags) && post.tags.length
                ? this.normalizeTags(post.tags)
                : this.extractHashtags(post.caption),
            viewsCount: typeof post.viewsCount === 'number'
                ? post.viewsCount
                : Array.isArray(post.viewedBy)
                    ? post.viewedBy.length
                    : 0,
            engagementScore: typeof post.engagementScore === 'number' ? post.engagementScore : 0,
        };
        if (!this.isRankingDebugEnabled()) {
            delete normalized.rankingDebug;
        }
        return normalized;
    }
    async syncLinkedCirclePost(post) {
        const circlePostId = post.circlePostId?.toString().trim();
        if (!circlePostId || !isValidObjectId(circlePostId)) {
            return;
        }
        const circlePost = await this.circlePostModel.findById(circlePostId).exec();
        if (!circlePost) {
            return;
        }
        const imageUrls = Array.isArray(post.imageUrls)
            ? post.imageUrls
                .map((item) => item?.toString().trim())
                .filter((item) => Boolean(item))
            : [];
        circlePost.caption = post.caption?.trim();
        circlePost.imageUrl = imageUrls[0];
        circlePost.imageUrls = imageUrls;
        circlePost.tags = this.resolvePostTags(post.caption, post.tags);
        circlePost.layoutStyle = post.layoutStyle || 'classic';
        await circlePost.save();
    }
    async deleteLinkedCirclePost(post) {
        const circlePostId = post.circlePostId?.toString().trim();
        if (!circlePostId || !isValidObjectId(circlePostId)) {
            return;
        }
        const linkedCirclePost = await this.circlePostModel
            .findById(circlePostId)
            .exec();
        if (!linkedCirclePost) {
            return;
        }
        const circleId = linkedCirclePost.circleId?.toString().trim();
        await this.circlePostModel.deleteOne({ _id: linkedCirclePost._id }).exec();
        if (circleId && isValidObjectId(circleId)) {
            const [postsCount, latestPost] = await Promise.all([
                this.circlePostModel.countDocuments({ circleId }).exec(),
                this.circlePostModel
                    .findOne({ circleId })
                    .sort({ createdAt: -1, _id: -1 })
                    .select('createdAt')
                    .lean()
                    .exec(),
            ]);
            await this.circleModel
                .findByIdAndUpdate(circleId, {
                $set: {
                    postsCount,
                    lastPostAt: latestPost?.createdAt || null,
                },
            })
                .exec();
        }
    }
    escapeRegExp(raw) {
        return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    buildPostsFilter(tag, authorName) {
        const clauses = [];
        if (tag?.trim()) {
            const normalizedTag = this.normalizeTag(tag);
            if (!normalizedTag) {
                return { _id: { $exists: false } };
            }
            clauses.push({
                $or: [
                    { tags: normalizedTag },
                    { caption: new RegExp(`(^|\\s)#${normalizedTag}(\\b|\\s|$)`, 'i') },
                ],
            });
        }
        if (authorName?.trim()) {
            clauses.push({
                authorName: new RegExp(this.escapeRegExp(authorName.trim()), 'i'),
            });
        }
        if (!clauses.length)
            return {};
        return clauses.length === 1 ? clauses[0] : { $and: clauses };
    }
    sanitizeListSort(sort) {
        return sort?.trim().toLowerCase() == 'trending' ? 'trending' : 'recent';
    }
    buildTrendingPostsPipeline(filter, offset, limit, followedAuthorIds = [], affinityAuthorIds = [], affinityTags = [], fatiguedAuthorIds = [], seenPostIds = []) {
        const cfg = this.getRankingConfig();
        const debugEnabled = this.isRankingDebugEnabled();
        return [
            { $match: filter },
            {
                $lookup: {
                    from: 'users',
                    let: { authorId: '$userId' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: [{ $toString: '$_id' }, '$$authorId'],
                                },
                            },
                        },
                        {
                            $project: {
                                followersCount: 1,
                                followerIds: 1,
                            },
                        },
                    ],
                    as: 'authorUser',
                },
            },
            {
                $addFields: {
                    authorUser: { $arrayElemAt: ['$authorUser', 0] },
                },
            },
            {
                $addFields: {
                    normalizedViews: {
                        $ifNull: ['$viewsCount', { $size: { $ifNull: ['$viewedBy', []] } }],
                    },
                    reactionsCount: { $size: { $ifNull: ['$reactions', []] } },
                    commentsCount: { $size: { $ifNull: ['$comments', []] } },
                    sharesCount: { $size: { $ifNull: ['$shares', []] } },
                    followersCount: {
                        $max: [
                            { $ifNull: ['$authorUser.followersCount', 0] },
                            { $size: { $ifNull: ['$authorUser.followerIds', []] } },
                        ],
                    },
                    ageHours: {
                        $divide: [
                            {
                                $max: [
                                    0,
                                    {
                                        $subtract: ['$$NOW', { $ifNull: ['$createdAt', '$$NOW'] }],
                                    },
                                ],
                            },
                            3600000,
                        ],
                    },
                    isFollowedAuthor: { $in: ['$userId', followedAuthorIds] },
                    hasAuthorAffinity: { $in: ['$userId', affinityAuthorIds] },
                    isFatiguedAuthor: { $in: ['$userId', fatiguedAuthorIds] },
                    hasSeenPost: { $in: [{ $toString: '$_id' }, seenPostIds] },
                    matchingAffinityTagsCount: {
                        $size: {
                            $setIntersection: [{ $ifNull: ['$tags', []] }, affinityTags],
                        },
                    },
                },
            },
            {
                $addFields: {
                    engagementScore: {
                        $divide: [
                            {
                                $add: [
                                    { $multiply: ['$normalizedViews', cfg.viewsWeight] },
                                    { $multiply: ['$reactionsCount', cfg.reactionsWeight] },
                                    { $multiply: ['$commentsCount', cfg.commentsWeight] },
                                    { $multiply: ['$sharesCount', cfg.sharesWeight] },
                                    {
                                        $multiply: [
                                            {
                                                $min: [{ $sqrt: { $max: ['$followersCount', 0] } }, 24],
                                            },
                                            cfg.followersWeight,
                                        ],
                                    },
                                    {
                                        $cond: ['$isFollowedAuthor', cfg.followedAuthorBoost, 0],
                                    },
                                    {
                                        $cond: ['$hasAuthorAffinity', cfg.affinityAuthorBoost, 0],
                                    },
                                    {
                                        $multiply: [
                                            {
                                                $min: ['$matchingAffinityTagsCount', 3],
                                            },
                                            cfg.affinityTagWeight,
                                        ],
                                    },
                                    {
                                        $cond: ['$isFatiguedAuthor', -cfg.fatiguedAuthorPenalty, 0],
                                    },
                                    {
                                        $cond: ['$hasSeenPost', -cfg.seenPostPenalty, 0],
                                    },
                                    {
                                        $cond: [
                                            { $lte: ['$ageHours', cfg.freshnessDecayHours] },
                                            {
                                                $multiply: [
                                                    {
                                                        $add: [
                                                            {
                                                                $multiply: [
                                                                    '$reactionsCount',
                                                                    cfg.freshnessReactionWeight,
                                                                ],
                                                            },
                                                            {
                                                                $multiply: [
                                                                    '$commentsCount',
                                                                    cfg.freshnessCommentWeight,
                                                                ],
                                                            },
                                                            {
                                                                $multiply: [
                                                                    '$sharesCount',
                                                                    cfg.freshnessShareWeight,
                                                                ],
                                                            },
                                                        ],
                                                    },
                                                    {
                                                        $divide: [
                                                            cfg.freshnessDecayHours,
                                                            { $add: ['$ageHours', 2] },
                                                        ],
                                                    },
                                                ],
                                            },
                                            0,
                                        ],
                                    },
                                ],
                            },
                            {
                                $add: [
                                    1,
                                    { $divide: ['$ageHours', cfg.timeDecayDivisorHours] },
                                ],
                            },
                        ],
                    },
                },
            },
            ...(debugEnabled
                ? [
                    {
                        $addFields: {
                            rankingDebug: {
                                viewsContribution: {
                                    $multiply: ['$normalizedViews', cfg.viewsWeight],
                                },
                                reactionsContribution: {
                                    $multiply: ['$reactionsCount', cfg.reactionsWeight],
                                },
                                commentsContribution: {
                                    $multiply: ['$commentsCount', cfg.commentsWeight],
                                },
                                sharesContribution: {
                                    $multiply: ['$sharesCount', cfg.sharesWeight],
                                },
                                followedAuthorBoost: {
                                    $cond: ['$isFollowedAuthor', cfg.followedAuthorBoost, 0],
                                },
                                affinityAuthorBoost: {
                                    $cond: ['$hasAuthorAffinity', cfg.affinityAuthorBoost, 0],
                                },
                                affinityTagBoost: {
                                    $multiply: [
                                        { $min: ['$matchingAffinityTagsCount', 3] },
                                        cfg.affinityTagWeight,
                                    ],
                                },
                                fatiguedAuthorPenalty: {
                                    $cond: ['$isFatiguedAuthor', cfg.fatiguedAuthorPenalty, 0],
                                },
                                seenPostPenalty: {
                                    $cond: ['$hasSeenPost', cfg.seenPostPenalty, 0],
                                },
                                ageHours: '$ageHours',
                                isFollowedAuthor: '$isFollowedAuthor',
                                hasAuthorAffinity: '$hasAuthorAffinity',
                                isFatiguedAuthor: '$isFatiguedAuthor',
                                hasSeenPost: '$hasSeenPost',
                                matchingAffinityTagsCount: '$matchingAffinityTagsCount',
                            },
                        },
                    },
                ]
                : []),
            {
                $sort: {
                    engagementScore: -1,
                    createdAt: -1,
                    _id: -1,
                },
            },
            { $skip: offset },
            { $limit: limit },
            {
                $project: {
                    normalizedViews: 0,
                    reactionsCount: 0,
                    commentsCount: 0,
                    sharesCount: 0,
                    followersCount: 0,
                    ageHours: 0,
                    isFollowedAuthor: 0,
                    hasAuthorAffinity: 0,
                    isFatiguedAuthor: 0,
                    hasSeenPost: 0,
                    matchingAffinityTagsCount: 0,
                    authorUser: 0,
                },
            },
        ];
    }
    async resolveViewerFollowingIds(viewerId) {
        if (!viewerId || !isValidObjectId(viewerId)) {
            return [];
        }
        const viewer = await this.userAccountService.findById(viewerId);
        if (!viewer || !Array.isArray(viewer.followingIds)) {
            return [];
        }
        return Array.from(new Set(viewer.followingIds
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter((id) => id.length > 0)));
    }
    async resolveViewerAffinity(viewerId) {
        if (!viewerId || !isValidObjectId(viewerId)) {
            return {
                authorIds: [],
                tags: [],
                fatiguedAuthorIds: [],
                seenPostIds: [],
                hiddenPostIds: [],
                mutedAuthorIds: [],
            };
        }
        const affinityRows = await this.wallPostModel
            .aggregate([
            {
                $match: {
                    $or: [
                        { reactions: { $elemMatch: { userId: viewerId } } },
                        { comments: { $elemMatch: { userId: viewerId } } },
                        { shares: { $elemMatch: { userId: viewerId } } },
                    ],
                },
            },
            {
                $project: {
                    userId: 1,
                    tags: { $ifNull: ['$tags', []] },
                    reactionMatches: {
                        $size: {
                            $filter: {
                                input: { $ifNull: ['$reactions', []] },
                                as: 'reaction',
                                cond: { $eq: ['$$reaction.userId', viewerId] },
                            },
                        },
                    },
                    commentMatches: {
                        $size: {
                            $filter: {
                                input: { $ifNull: ['$comments', []] },
                                as: 'comment',
                                cond: { $eq: ['$$comment.userId', viewerId] },
                            },
                        },
                    },
                    shareMatches: {
                        $size: {
                            $filter: {
                                input: { $ifNull: ['$shares', []] },
                                as: 'share',
                                cond: { $eq: ['$$share.userId', viewerId] },
                            },
                        },
                    },
                },
            },
        ])
            .exec();
        const dwellRows = await this.wallViewEventModel
            .aggregate([
            { $match: { viewerId } },
            {
                $project: {
                    postId: 1,
                    authorId: 1,
                    tags: { $ifNull: ['$tags', []] },
                    viewsCount: { $ifNull: ['$viewsCount', 0] },
                    hiddenPost: { $ifNull: ['$hiddenPost', false] },
                    mutedAuthor: { $ifNull: ['$mutedAuthor', false] },
                    tooRepetitiveCount: { $ifNull: ['$tooRepetitiveCount', 0] },
                    notMyTypeCount: { $ifNull: ['$notMyTypeCount', 0] },
                    dwellWeight: {
                        $min: [
                            6,
                            {
                                $add: [
                                    1,
                                    {
                                        $floor: {
                                            $divide: [{ $ifNull: ['$totalDwellMs', 0] }, 1500],
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                    interactionWeight: {
                        $add: [
                            {
                                $multiply: [{ $ifNull: ['$profileOpenCount', 0] }, 3],
                            },
                            {
                                $multiply: [{ $ifNull: ['$commentOpenCount', 0] }, 2],
                            },
                            {
                                $multiply: [{ $ifNull: ['$mediaOpenCount', 0] }, 2],
                            },
                            {
                                $multiply: [{ $ifNull: ['$tagTapCount', 0] }, 2],
                            },
                            {
                                $min: [
                                    6,
                                    {
                                        $floor: {
                                            $divide: [{ $ifNull: ['$mediaDwellMs', 0] }, 2000],
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
        ])
            .exec();
        const authorAffinity = new Map();
        const tagAffinity = new Map();
        const authorExposure = new Map();
        const seenPostIds = new Set();
        const hiddenPostIds = new Set();
        const mutedAuthorIds = new Set();
        for (const row of affinityRows) {
            const authorId = String(row.userId || '').trim();
            const weight = Number(row.reactionMatches || 0) * 1 +
                Number(row.commentMatches || 0) * 2 +
                Number(row.shareMatches || 0) * 3;
            if (authorId && weight > 0) {
                authorAffinity.set(authorId, (authorAffinity.get(authorId) || 0) + weight);
            }
            const tags = Array.isArray(row.tags) ? row.tags : [];
            for (const tag of tags) {
                const normalizedTag = this.normalizeTag(String(tag || ''));
                if (!normalizedTag)
                    continue;
                tagAffinity.set(normalizedTag, (tagAffinity.get(normalizedTag) || 0) + weight);
            }
        }
        for (const row of dwellRows) {
            const authorId = String(row.authorId || '').trim();
            const weight = Number(row.dwellWeight || 0) + Number(row.interactionWeight || 0);
            const postId = String(row.postId || '').trim();
            const viewsCount = Number(row.viewsCount || 0);
            const hiddenPost = Boolean(row.hiddenPost);
            const mutedAuthor = Boolean(row.mutedAuthor);
            const negativeWeight = Number(row.tooRepetitiveCount || 0) * 4 +
                Number(row.notMyTypeCount || 0) * 6;
            if (hiddenPost && postId) {
                hiddenPostIds.add(postId);
            }
            if (mutedAuthor && authorId) {
                mutedAuthorIds.add(authorId);
            }
            if (postId && viewsCount > 0) {
                seenPostIds.add(postId);
            }
            if (authorId && viewsCount > 0) {
                authorExposure.set(authorId, (authorExposure.get(authorId) || 0) + viewsCount);
            }
            if (authorId && weight > 0) {
                authorAffinity.set(authorId, (authorAffinity.get(authorId) || 0) + weight);
            }
            if (authorId && negativeWeight > 0) {
                authorAffinity.set(authorId, (authorAffinity.get(authorId) || 0) - negativeWeight);
            }
            const tags = Array.isArray(row.tags) ? row.tags : [];
            for (const tag of tags) {
                const normalizedTag = this.normalizeTag(String(tag || ''));
                if (!normalizedTag)
                    continue;
                tagAffinity.set(normalizedTag, (tagAffinity.get(normalizedTag) || 0) + weight - negativeWeight);
            }
        }
        const authorIds = Array.from(authorAffinity.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([authorId]) => authorId);
        const tags = Array.from(tagAffinity.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([tag]) => tag);
        const fatiguedAuthorIds = Array.from(authorExposure.entries())
            .filter(([, exposure]) => exposure >= 4)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([authorId]) => authorId);
        return {
            authorIds,
            tags,
            fatiguedAuthorIds,
            seenPostIds: Array.from(seenPostIds).slice(0, 200),
            hiddenPostIds: Array.from(hiddenPostIds).slice(0, 200),
            mutedAuthorIds: Array.from(mutedAuthorIds).slice(0, 200),
        };
    }
    resolveFollowersCount(user) {
        const fromCount = typeof user?.followersCount === 'number' ? user.followersCount : 0;
        const fromIds = Array.isArray(user?.followerIds)
            ? user.followerIds.length
            : 0;
        return Math.max(fromCount, fromIds);
    }
    async buildAuthorMetaMap(userIds, applyRewards = false) {
        const uniqueUserIds = Array.from(new Set(userIds
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter((id) => id.length > 0)));
        const emptyMeta = {
            authorBadges: [],
            authorBadgeCount: 0,
            authorRating: { score: 0, level: 'New' },
        };
        if (!uniqueUserIds.length) {
            return new Map();
        }
        const statsRows = await this.wallPostModel
            .aggregate([
            { $match: { userId: { $in: uniqueUserIds } } },
            {
                $project: {
                    userId: 1,
                    normalizedViews: {
                        $ifNull: [
                            '$viewsCount',
                            { $size: { $ifNull: ['$viewedBy', []] } },
                        ],
                    },
                    reactionsCount: { $size: { $ifNull: ['$reactions', []] } },
                    commentsCount: { $size: { $ifNull: ['$comments', []] } },
                    sharesCount: { $size: { $ifNull: ['$shares', []] } },
                },
            },
            {
                $group: {
                    _id: '$userId',
                    postsCount: { $sum: 1 },
                    viewsCount: { $sum: '$normalizedViews' },
                    reactionsCount: { $sum: '$reactionsCount' },
                    commentsCount: { $sum: '$commentsCount' },
                    sharesCount: { $sum: '$sharesCount' },
                },
            },
        ])
            .exec();
        const statsMap = new Map(statsRows.map((item) => [String(item._id || ''), item]));
        const users = await this.userAccountService.findManyByIds(uniqueUserIds, '_id followersCount followerIds profileCompletion earnedBadgeIds badgeRewardPointsTotal');
        const usersMap = new Map(users.map((user) => [user._id?.toString() || '', user]));
        const metaMap = new Map();
        for (const userId of uniqueUserIds) {
            const stats = statsMap.get(userId);
            const user = usersMap.get(userId);
            const snapshot = {
                postsCount: Number(stats?.postsCount || 0),
                viewsCount: Number(stats?.viewsCount || 0),
                reactionsCount: Number(stats?.reactionsCount || 0),
                commentsCount: Number(stats?.commentsCount || 0),
                sharesCount: Number(stats?.sharesCount || 0),
                followersCount: this.resolveFollowersCount(user),
                profileCompletion: Number(user?.profileCompletion || 0),
            };
            const badges = evaluateUserBadges(snapshot);
            const rating = computeUserRating(snapshot, badges.length);
            const earnedBadgeIds = new Set(Array.isArray(user?.earnedBadgeIds)
                ? user.earnedBadgeIds
                    .map((id) => id?.toString().trim())
                    .filter((id) => id.length > 0)
                : []);
            const newlyUnlockedBadges = badges.filter((badge) => !earnedBadgeIds.has(badge.id));
            if (applyRewards &&
                newlyUnlockedBadges.length &&
                isValidObjectId(userId)) {
                const newBadgeIds = newlyUnlockedBadges.map((badge) => badge.id);
                const rewardPoints = newlyUnlockedBadges.reduce((sum, badge) => sum + badge.rewardPoints, 0);
                if (rewardPoints > 0) {
                    await this.userAccountService.updateById(userId, {
                        earnedBadgeIds: Array.from(new Set([...earnedBadgeIds, ...newBadgeIds])),
                        badgeRewardPointsTotal: Number(user?.badgeRewardPointsTotal || 0) + rewardPoints,
                    });
                    await this.userAccountService.incrementPoints(userId, rewardPoints);
                }
            }
            metaMap.set(userId, {
                authorBadges: badges,
                authorBadgeCount: badges.length,
                authorRating: rating,
            });
        }
        return metaMap;
    }
    async enrichPostsWithAuthorMeta(posts, applyRewards = false) {
        const normalizedPosts = posts.map((post) => this.normalizePostPayload(post));
        if (!normalizedPosts.length)
            return normalizedPosts;
        const metaMap = await this.buildAuthorMetaMap(normalizedPosts.map((post) => String(post.userId || '')), applyRewards);
        return normalizedPosts.map((post) => ({
            ...post,
            ...(metaMap.get(String(post.userId || '')) || {
                authorBadges: [],
                authorBadgeCount: 0,
                authorRating: { score: 0, level: 'New' },
            }),
        }));
    }
    async enrichSinglePostWithAuthorMeta(post, applyRewards = true) {
        const [enriched] = await this.enrichPostsWithAuthorMeta([post], applyRewards);
        return enriched;
    }
    diversifyFeed(posts, limit) {
        const debugEnabled = this.isRankingDebugEnabled();
        if (!posts.length)
            return posts;
        const remaining = [...posts];
        const selected = [];
        const authorSeenCount = new Map();
        while (remaining.length && selected.length < limit) {
            let bestIndex = 0;
            let bestScore = -Infinity;
            for (let i = 0; i < remaining.length; i += 1) {
                const post = remaining[i];
                const authorId = String(post.userId || '').trim();
                const seenCount = authorSeenCount.get(authorId) || 0;
                const recentAuthors = selected
                    .slice(-2)
                    .map((item) => String(item.userId || '').trim());
                const immediateRepeatPenalty = recentAuthors.includes(authorId)
                    ? 20
                    : 0;
                const repeatedAuthorPenalty = seenCount * 12;
                const recencyTieBreaker = Math.max(0, 6 - i * 0.35);
                const score = Number(post.engagementScore || 0) -
                    immediateRepeatPenalty -
                    repeatedAuthorPenalty +
                    recencyTieBreaker;
                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                }
            }
            const [nextPost] = remaining.splice(bestIndex, 1);
            const authorId = String(nextPost.userId || '').trim();
            if (debugEnabled) {
                nextPost.rankingDebug = {
                    ...(nextPost.rankingDebug || {}),
                    diversityAuthorSeenCount: authorSeenCount.get(authorId) || 0,
                    diversitySelectedIndex: selected.length,
                };
            }
            selected.push(nextPost);
            authorSeenCount.set(authorId, (authorSeenCount.get(authorId) || 0) + 1);
        }
        return selected;
    }
    async countPostsToday(actorId) {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        return this.wallPostModel.countDocuments({
            userId: actorId,
            createdAt: { $gte: startOfToday },
        });
    }
    async createPost(actorId, dto) {
        const videoUrl = dto.videoUrl?.trim();
        const videoThumbnailUrl = dto.videoThumbnailUrl?.trim();
        const hasImages = Boolean((dto.imageUrls && dto.imageUrls.length) || dto.imageUrl);
        if (videoUrl && hasImages) {
            throw new BadRequestException('Post cannot contain both images and video.');
        }
        if (!dto.caption &&
            !videoUrl &&
            !(dto.imageUrls && dto.imageUrls.length) &&
            !dto.imageUrl) {
            throw new BadRequestException('Post must have a caption, an image, or a video.');
        }
        const captionModeration = this.textModerationService.check(dto.caption);
        if (captionModeration.blocked) {
            throw new BadRequestException(captionModeration.reason);
        }
        const imageUrls = videoUrl ? [] : (dto.imageUrls && dto.imageUrls.length ? dto.imageUrls : []);
        if (!imageUrls.length && dto.imageUrl && !videoUrl) {
            imageUrls.push(dto.imageUrl);
        }
        for (const url of imageUrls) {
            const key = this.s3Service.parseKeyFromUrl(url);
            if (key && await this.rekognitionService.isAdultContent(key)) {
                throw new BadRequestException('Image contains adult or explicit content and cannot be posted.');
            }
        }
        const post = await this.wallPostModel.create({
            userId: actorId,
            authorName: dto.authorName,
            authorAvatar: dto.authorAvatar,
            caption: dto.caption,
            imageUrl: imageUrls[0],
            imageUrls,
            imageThumbnailUrls: videoUrl ? [] : (dto.imageThumbnailUrls && dto.imageThumbnailUrls.length ? dto.imageThumbnailUrls : []),
            videoUrl,
            videoThumbnailUrl,
            tags: this.resolvePostTags(dto.caption, dto.tags),
            layoutStyle: dto.layoutStyle || 'classic',
            reactions: [],
            comments: [],
            imageEngagement: imageUrls.map((imageUrl, imageIndex) => ({
                imageIndex,
                imageUrl,
                reactions: [],
                comments: [],
                updatedAt: new Date(),
            })),
            viewedBy: [],
            viewsCount: 0,
        });
        const points = Number(process.env.WALL_POST_POINTS || 5);
        if (actorId && isValidObjectId(actorId)) {
            await this.userAccountService.incrementPoints(actorId, points);
        }
        await this.eventPublisher.publish(createDomainEvent(DOMAIN_EVENT_TYPES.wallPostCreated, {
            postId: post._id.toString(),
        }));
        return this.enrichSinglePostWithAuthorMeta(post.toObject());
    }
    normalizeLegacyComments(post) {
        if (!post.comments?.length)
            return;
        for (const comment of post.comments) {
            if (!comment.commentId) {
                comment.commentId = randomUUID();
            }
            comment.reactions = comment.reactions || [];
            comment.updatedAt = comment.updatedAt || comment.createdAt || new Date();
        }
    }
    normalizeImageEngagement(post) {
        const imageUrls = post.imageUrls || [];
        post.imageEngagement = (post.imageEngagement || [])
            .filter((item) => Number.isInteger(item.imageIndex) &&
            item.imageIndex >= 0 &&
            item.imageIndex < imageUrls.length)
            .map((item) => {
            item.imageUrl = imageUrls[item.imageIndex];
            item.reactions = item.reactions || [];
            item.comments = item.comments || [];
            item.updatedAt = item.updatedAt || new Date();
            for (const comment of item.comments) {
                if (!comment.commentId) {
                    comment.commentId = randomUUID();
                }
                comment.reactions = comment.reactions || [];
                comment.updatedAt =
                    comment.updatedAt || comment.createdAt || new Date();
            }
            return item;
        });
    }
    getImageEngagement(post, imageIndex) {
        const imageUrls = post.imageUrls || [];
        if (imageIndex < 0 || imageIndex >= imageUrls.length) {
            throw new BadRequestException('Invalid image index');
        }
        post.imageEngagement = post.imageEngagement || [];
        let imageEngagement = post.imageEngagement.find((item) => item.imageIndex === imageIndex);
        if (!imageEngagement) {
            imageEngagement = {
                imageIndex,
                imageUrl: imageUrls[imageIndex],
                reactions: [],
                comments: [],
                updatedAt: new Date(),
            };
            post.imageEngagement.push(imageEngagement);
        }
        imageEngagement.imageUrl = imageUrls[imageIndex];
        imageEngagement.reactions = imageEngagement.reactions || [];
        imageEngagement.comments = imageEngagement.comments || [];
        imageEngagement.updatedAt = new Date();
        return imageEngagement;
    }
    async listPosts(limit = 20, offset = 0, tag, sort, viewerId, authorName) {
        const safeLimit = Math.max(1, Math.min(limit, 50));
        const safeOffset = Math.max(0, Number.isFinite(offset) ? offset : 0);
        const filter = this.buildPostsFilter(tag, authorName);
        const sortMode = this.sanitizeListSort(sort);
        const candidateLimit = sortMode === 'trending'
            ? Math.min(150, Math.max(safeLimit * 3, safeLimit + 10))
            : safeLimit;
        const followedAuthorIds = sortMode === 'trending'
            ? await this.resolveViewerFollowingIds(viewerId)
            : [];
        const viewerAffinity = sortMode === 'trending'
            ? await this.resolveViewerAffinity(viewerId)
            : {
                authorIds: [],
                tags: [],
                fatiguedAuthorIds: [],
                seenPostIds: [],
                hiddenPostIds: [],
                mutedAuthorIds: [],
            };
        const rawPosts = sortMode === 'trending'
            ? await this.wallPostModel
                .aggregate(this.buildTrendingPostsPipeline(filter, safeOffset, candidateLimit, followedAuthorIds, viewerAffinity.authorIds, viewerAffinity.tags, viewerAffinity.fatiguedAuthorIds, viewerAffinity.seenPostIds))
                .exec()
            : await this.wallPostModel
                .find(filter)
                .sort({ createdAt: -1 })
                .skip(safeOffset)
                .limit(candidateLimit)
                .lean()
                .exec();
        const hiddenPostIdSet = new Set(viewerAffinity.hiddenPostIds);
        const mutedAuthorIdSet = new Set(viewerAffinity.mutedAuthorIds);
        const posts = rawPosts.filter((post) => {
            const postId = String(post._id || '').trim();
            const authorId = String(post.userId || '').trim();
            if (postId && hiddenPostIdSet.has(postId)) {
                return false;
            }
            if (authorId && mutedAuthorIdSet.has(authorId)) {
                return false;
            }
            return true;
        });
        const enrichedPosts = await this.enrichPostsWithAuthorMeta(posts, true);
        const rankedPosts = sortMode === 'trending'
            ? this.diversifyFeed(enrichedPosts, safeLimit)
            : enrichedPosts;
        if (!viewerId) {
            return rankedPosts;
        }
        const sponsored = await this.advertisementPlacementService.resolveSponsoredPostForViewer(viewerId, rankedPosts.map((post) => String(post._id || '')));
        if (!sponsored) {
            return rankedPosts;
        }
        const sponsoredPost = await this.enrichSinglePostWithAuthorMeta(sponsored.post, false);
        const sponsoredCampaign = sponsored.campaign;
        const injectedPost = {
            ...sponsoredPost,
            isSponsored: true,
            sponsoredLabel: 'Sponsored',
            advertisementId: sponsoredCampaign._id?.toString() ?? sponsoredCampaign.id,
            advertisementHeadline: sponsoredCampaign.headline ?? null,
            advertisementAudienceSummary: sponsoredCampaign.audienceSummary,
            advertisementDeliveredCount: sponsoredCampaign.deliveredCount,
            advertisementTargetAudienceCount: sponsoredCampaign.targetAudienceCount,
        };
        const insertAt = Math.min(2, rankedPosts.length);
        const merged = [...rankedPosts];
        merged.splice(insertAt, 0, injectedPost);
        return merged.slice(0, safeLimit);
    }
    async editPost(postId, actorId, dto) {
        if (!isValidObjectId(postId)) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post)
            throw new NotFoundException('Post not found');
        if (post.userId !== actorId) {
            throw new BadRequestException('Only the post owner can edit this post');
        }
        const nextCaption = typeof dto.caption === 'string' ? dto.caption.trim() : (post.caption || '').trim();
        const nextImageUrls = dto.imageUrls ?? post.imageUrls ?? [];
        const nextVideoUrl = typeof dto.videoUrl === 'string' ? dto.videoUrl.trim() : (post.videoUrl || '').trim();
        const nextVideoThumbnailUrl = typeof dto.videoThumbnailUrl === 'string'
            ? dto.videoThumbnailUrl.trim()
            : (post.videoThumbnailUrl || '').trim();
        const hasImages = Boolean(nextImageUrls?.length);
        const hasVideo = Boolean(nextVideoUrl);
        if (hasImages && hasVideo) {
            throw new BadRequestException('Post cannot contain both images and video.');
        }
        if (!nextCaption && !hasImages && !hasVideo) {
            throw new BadRequestException('Post must have a caption, an image, or a video.');
        }
        if (typeof dto.caption === 'string') {
            const captionModeration = this.textModerationService.check(nextCaption);
            if (captionModeration.blocked) {
                throw new BadRequestException(captionModeration.reason);
            }
        }
        if (!hasVideo && nextImageUrls.length) {
            for (const url of nextImageUrls) {
                const key = this.s3Service.parseKeyFromUrl(url);
                if (key && await this.rekognitionService.isAdultContent(key)) {
                    throw new BadRequestException('Image contains adult or explicit content and cannot be posted.');
                }
            }
        }
        post.caption = nextCaption || undefined;
        post.imageUrls = hasVideo ? [] : nextImageUrls;
        post.imageUrl = hasVideo ? undefined : nextImageUrls[0];
        post.videoUrl = hasImages ? undefined : (nextVideoUrl || undefined);
        post.videoThumbnailUrl = hasImages ? undefined : (nextVideoThumbnailUrl || undefined);
        post.tags = this.resolvePostTags(nextCaption, dto.tags);
        post.layoutStyle = dto.layoutStyle ?? post.layoutStyle ?? 'classic';
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        await this.syncLinkedCirclePost(post);
        await this.eventPublisher.publish(createDomainEvent(DOMAIN_EVENT_TYPES.wallPostUpdated, {
            postId: post._id.toString(),
        }));
        return this.enrichSinglePostWithAuthorMeta(post.toObject());
    }
    async reactToPost(postId, actorId, dto) {
        this.logger.log(`reactToPost start postId=${postId} actorId=${actorId} type=${dto?.type} imageIndex=${dto?.imageIndex}`);
        if (!isValidObjectId(postId)) {
            this.logger.warn(`reactToPost invalidPostId postId=${postId} actorId=${actorId}`);
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post) {
            this.logger.warn(`reactToPost postNotFound postId=${postId} actorId=${actorId}`);
            throw new NotFoundException('Post not found');
        }
        if (typeof dto.imageIndex === 'number') {
            const imageEngagement = this.getImageEngagement(post, dto.imageIndex);
            const existing = imageEngagement.reactions?.find((reaction) => reaction.userId === actorId);
            if (existing) {
                if (existing.type === dto.type) {
                    imageEngagement.reactions = imageEngagement.reactions?.filter((reaction) => reaction.userId !== actorId);
                }
                else {
                    existing.type = dto.type;
                    existing.createdAt = new Date();
                }
            }
            else {
                imageEngagement.reactions = imageEngagement.reactions || [];
                imageEngagement.reactions.push({
                    userId: actorId,
                    type: dto.type,
                    createdAt: new Date(),
                });
            }
            imageEngagement.updatedAt = new Date();
            this.normalizeLegacyComments(post);
            this.normalizeImageEngagement(post);
            await post.save();
            this.logger.log(`reactToPost imageReactionSaved postId=${postId} actorId=${actorId} imageIndex=${dto.imageIndex}`);
            return this.enrichSinglePostWithAuthorMeta(post.toObject());
        }
        const existing = post.reactions?.find((reaction) => reaction.userId === actorId);
        if (existing) {
            if (existing.type === dto.type) {
                post.reactions = post.reactions?.filter((reaction) => reaction.userId !== actorId);
            }
            else {
                existing.type = dto.type;
                existing.createdAt = new Date();
            }
        }
        else {
            post.reactions = post.reactions || [];
            post.reactions.push({
                userId: actorId,
                type: dto.type,
                createdAt: new Date(),
            });
        }
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        this.logger.log(`reactToPost saved postId=${postId} actorId=${actorId}`);
        return this.enrichSinglePostWithAuthorMeta(post.toObject());
    }
    async addComment(postId, actorId, dto) {
        if (!isValidObjectId(postId)) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post)
            throw new NotFoundException('Post not found');
        const commentModeration = this.textModerationService.check(dto.text);
        if (commentModeration.blocked) {
            throw new BadRequestException(commentModeration.reason);
        }
        if (typeof dto.imageIndex === 'number') {
            const imageEngagement = this.getImageEngagement(post, dto.imageIndex);
            imageEngagement.comments = imageEngagement.comments || [];
            imageEngagement.comments.push({
                commentId: randomUUID(),
                userId: actorId,
                authorName: dto.authorName,
                authorAvatar: dto.authorAvatar,
                text: dto.text,
                reactions: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            imageEngagement.updatedAt = new Date();
            this.normalizeLegacyComments(post);
            this.normalizeImageEngagement(post);
            await post.save();
            return this.enrichSinglePostWithAuthorMeta(post.toObject());
        }
        post.comments = post.comments || [];
        post.comments.push({
            commentId: randomUUID(),
            userId: actorId,
            authorName: dto.authorName,
            authorAvatar: dto.authorAvatar,
            text: dto.text,
            reactions: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        return this.enrichSinglePostWithAuthorMeta(post.toObject());
    }
    async reactToComment(postId, commentId, actorId, dto) {
        this.logger.log(`reactToComment start postId=${postId} commentId=${commentId} actorId=${actorId} type=${dto?.type}`);
        if (!isValidObjectId(postId)) {
            this.logger.warn(`reactToComment invalidPostId postId=${postId} commentId=${commentId} actorId=${actorId}`);
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post) {
            this.logger.warn(`reactToComment postNotFound postId=${postId} commentId=${commentId} actorId=${actorId}`);
            throw new NotFoundException('Post not found');
        }
        const comment = post.comments?.find((item) => item.commentId === commentId);
        if (!comment) {
            this.logger.warn(`reactToComment commentNotFound postId=${postId} commentId=${commentId} actorId=${actorId}`);
            throw new NotFoundException('Comment not found');
        }
        const existing = comment.reactions?.find((reaction) => reaction.userId === actorId);
        if (existing) {
            if (existing.type === dto.type) {
                comment.reactions = comment.reactions?.filter((reaction) => reaction.userId !== actorId);
            }
            else {
                existing.type = dto.type;
                existing.createdAt = new Date();
            }
        }
        else {
            comment.reactions = comment.reactions || [];
            comment.reactions.push({
                userId: actorId,
                type: dto.type,
                createdAt: new Date(),
            });
        }
        comment.updatedAt = new Date();
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        this.logger.log(`reactToComment saved postId=${postId} commentId=${commentId} actorId=${actorId}`);
        return this.enrichSinglePostWithAuthorMeta(post.toObject());
    }
    findCommentTarget(post, commentId, imageIndex) {
        if (typeof imageIndex === 'number') {
            const imageEngagement = this.getImageEngagement(post, imageIndex);
            imageEngagement.comments = imageEngagement.comments || [];
            const comment = imageEngagement.comments.find((item) => item.commentId === commentId);
            return {
                comments: imageEngagement.comments,
                comment,
                touch: () => {
                    imageEngagement.updatedAt = new Date();
                },
            };
        }
        post.comments = post.comments || [];
        const comment = post.comments.find((item) => item.commentId === commentId);
        return {
            comments: post.comments,
            comment,
            touch: () => undefined,
        };
    }
    async deleteComment(postId, commentId, actorId, dto) {
        if (!isValidObjectId(postId)) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post)
            throw new NotFoundException('Post not found');
        const target = this.findCommentTarget(post, commentId, dto?.imageIndex);
        if (!target.comment) {
            throw new NotFoundException('Comment not found');
        }
        if (target.comment.userId !== actorId) {
            throw new BadRequestException('You can only delete your own comments');
        }
        target.comments = target.comments.filter((item) => item.commentId !== commentId);
        if (typeof dto?.imageIndex === 'number') {
            const imageEngagement = this.getImageEngagement(post, dto.imageIndex);
            imageEngagement.comments = target.comments;
            imageEngagement.updatedAt = new Date();
        }
        else {
            post.comments = target.comments;
        }
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        return this.enrichSinglePostWithAuthorMeta(post.toObject());
    }
    async reportComment(postId, commentId, actorId, dto) {
        if (!isValidObjectId(postId)) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post)
            throw new NotFoundException('Post not found');
        const target = this.findCommentTarget(post, commentId, dto?.imageIndex);
        if (!target.comment) {
            throw new NotFoundException('Comment not found');
        }
        target.comment.reports = target.comment.reports || [];
        const existing = target.comment.reports.find((report) => report.userId === actorId);
        if (existing) {
            existing.reason = dto.reason;
            existing.description = dto.description;
            existing.createdAt = new Date();
        }
        else {
            target.comment.reports.push({
                userId: actorId,
                reason: dto.reason,
                description: dto.description,
                createdAt: new Date(),
            });
        }
        target.comment.updatedAt = new Date();
        target.touch();
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        return {
            postId,
            commentId,
            reportsCount: target.comment.reports.length,
        };
    }
    async reportPost(postId, actorId, dto) {
        if (!isValidObjectId(postId)) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post)
            throw new NotFoundException('Post not found');
        post.reports = post.reports || [];
        const existing = post.reports.find((report) => report.userId === actorId);
        if (existing) {
            existing.reason = dto.reason;
            existing.description = dto.description;
            existing.createdAt = new Date();
        }
        else {
            post.reports.push({
                userId: actorId,
                reason: dto.reason,
                description: dto.description,
                createdAt: new Date(),
            });
        }
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        return {
            postId,
            reportsCount: post.reports.length,
        };
    }
    async sharePost(postId, actorId, dto) {
        if (!isValidObjectId(postId)) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post)
            throw new NotFoundException('Post not found');
        post.shares = post.shares || [];
        post.shares.push({
            userId: actorId,
            sharedByName: dto.sharedByName,
            platform: dto.platform,
            createdAt: new Date(),
        });
        this.normalizeLegacyComments(post);
        this.normalizeImageEngagement(post);
        await post.save();
        const sharedImageUrls = post.imageUrls || [];
        const sharedPost = await this.wallPostModel.create({
            userId: actorId,
            authorName: dto.sharedByName || actorId,
            authorAvatar: dto.sharedByAvatar,
            caption: dto.caption?.trim() || post.caption,
            imageUrl: post.imageUrl,
            imageUrls: sharedImageUrls,
            tags: post.tags || [],
            layoutStyle: post.layoutStyle || 'classic',
            reactions: [],
            comments: [],
            imageEngagement: sharedImageUrls.map((imageUrl, imageIndex) => ({
                imageIndex,
                imageUrl,
                reactions: [],
                comments: [],
                updatedAt: new Date(),
            })),
            reports: [],
            shares: [],
            viewedBy: [],
            viewsCount: 0,
            isSharedPost: true,
            sharedFromPostId: post._id.toString(),
            sharedOriginalAuthorName: post.authorName || post.userId,
            sharedAt: new Date(),
            sourceType: post.sourceType || 'wall',
            circleId: post.circleId,
            circleName: post.circleName,
            circleAvatarUrl: post.circleAvatarUrl,
            circleVisibility: post.circleVisibility,
        });
        await this.eventPublisher.publish(createDomainEvent(DOMAIN_EVENT_TYPES.wallPostCreated, {
            postId: sharedPost._id.toString(),
        }));
        return {
            postId,
            sharesCount: post.shares.length,
            sharedPost: await this.enrichSinglePostWithAuthorMeta(sharedPost.toObject()),
        };
    }
    async markPostsViewed(actorId, postIds, dwellMsByPostId = {}) {
        const sanitizedPostIds = Array.from(new Set(postIds
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter((id) => id.length > 0 && isValidObjectId(id))));
        if (!sanitizedPostIds.length) {
            return { counts: {} };
        }
        const counts = {};
        await Promise.all(sanitizedPostIds.map(async (postId) => {
            const updatedPost = await this.wallPostModel
                .findOneAndUpdate({ _id: postId }, [
                {
                    $set: {
                        viewedBy: {
                            $setUnion: [{ $ifNull: ['$viewedBy', []] }, [actorId]],
                        },
                    },
                },
                {
                    $set: {
                        viewsCount: { $size: '$viewedBy' },
                    },
                },
            ], {
                new: true,
                projection: { _id: 1, viewsCount: 1, userId: 1, tags: 1 },
            })
                .lean()
                .exec();
            if (updatedPost?._id) {
                counts[updatedPost._id.toString()] = Number(updatedPost.viewsCount || 0);
                const normalizedDwellMs = Math.max(0, Math.min(Number(dwellMsByPostId[postId] || 0) || 0, 300000));
                await this.wallViewEventModel
                    .findOneAndUpdate({ viewerId: actorId, postId }, {
                    $set: {
                        authorId: String(updatedPost.userId || ''),
                        tags: Array.isArray(updatedPost.tags)
                            ? updatedPost.tags
                            : [],
                        lastViewedAt: new Date(),
                    },
                    $inc: {
                        totalDwellMs: normalizedDwellMs,
                        viewsCount: 1,
                    },
                }, {
                    upsert: true,
                    new: true,
                    setDefaultsOnInsert: true,
                })
                    .exec();
            }
        }));
        return { counts };
    }
    async trackPostInteraction(actorId, dto) {
        const postId = typeof dto.postId === 'string' && isValidObjectId(dto.postId.trim())
            ? dto.postId.trim()
            : '';
        if (!postId) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel
            .findById(postId)
            .select('_id userId tags')
            .lean()
            .exec();
        if (!post) {
            throw new NotFoundException('Post not found');
        }
        const normalizedTag = this.normalizeTag(dto.tag || '');
        const postTags = Array.isArray(post.tags)
            ? post.tags
                .map((tag) => this.normalizeTag(String(tag || '')))
                .filter((tag) => tag.length > 0)
            : [];
        const mergedTags = Array.from(new Set([...postTags, ...(normalizedTag ? [normalizedTag] : [])]));
        await this.wallViewEventModel
            .findOneAndUpdate({ viewerId: actorId, postId }, {
            $set: {
                authorId: String(post.userId || ''),
                tags: mergedTags,
                lastViewedAt: new Date(),
                ...(dto.hidePost ? { hiddenPost: true } : {}),
                ...(dto.muteAuthor ? { mutedAuthor: true } : {}),
            },
            $inc: {
                profileOpenCount: Math.max(0, Number(dto.profileOpenCount || 0) || 0),
                commentOpenCount: Math.max(0, Number(dto.commentOpenCount || 0) || 0),
                mediaOpenCount: Math.max(0, Number(dto.mediaOpenCount || 0) || 0),
                tagTapCount: Math.max(0, Number(dto.tagTapCount || 0) || 0),
                tooRepetitiveCount: dto.tooRepetitive ? 1 : 0,
                notMyTypeCount: dto.notMyType ? 1 : 0,
                mediaDwellMs: Math.max(0, Math.min(Number(dto.mediaDwellMs || 0) || 0, 300000)),
            },
        }, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        })
            .exec();
        return { tracked: true, postId };
    }
    async deletePost(postId, actorId) {
        if (!isValidObjectId(postId)) {
            throw new BadRequestException('Invalid post id');
        }
        const post = await this.wallPostModel.findById(postId);
        if (!post)
            throw new NotFoundException('Post not found');
        if (post.userId !== actorId) {
            throw new BadRequestException('Only the post owner can delete this post');
        }
        if (!post.isSharedPost) {
            await this.deleteLinkedCirclePost(post);
        }
        await this.wallPostModel.deleteOne({ _id: postId }).exec();
        await this.eventPublisher.publish(createDomainEvent(DOMAIN_EVENT_TYPES.wallPostDeleted, { postId }));
        return { deleted: true, postId };
    }

}
