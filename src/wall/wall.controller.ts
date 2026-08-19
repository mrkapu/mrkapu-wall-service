// @ts-nocheck
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AddCommentDto } from './dto/comment.dto';
import { CommentActionDto } from './dto/comment-action.dto';
import { ReactToCommentDto } from './dto/comment-react.dto';
import { CreateWallPostDto } from './dto/create-post.dto';
import { CreatePresignDto } from './dto/create-presign.dto';
import { EditWallPostDto } from './dto/edit-post.dto';
import { ReactToPostDto } from './dto/react.dto';
import { ReportPostDto } from './dto/report-post.dto';
import { ReportCommentDto } from './dto/report-comment.dto';
import { SharePostDto } from './dto/share-post.dto';
import { TrackWallInteractionDto } from './dto/track-interaction.dto';
import { ViewPostsDto } from './dto/view-posts.dto';
import { MembershipGuardService } from '../shared/membership/membership-guard.service';
import { WallService } from './wall.service';

@Controller('wall')
export class WallController {
  private readonly logger = new Logger(WallController.name);

  constructor(
    private readonly wallService: WallService,
    private readonly membershipGuard: MembershipGuardService,
  ) {}

  @Post('presign')
  async presign(
    @Headers('authorization') authorization: string,
    @Body() dto: CreatePresignDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.createPresignedUpload(actorId, dto);
  }

  @Post('posts')
  async createPost(
    @Headers('authorization') authorization: string,
    @Body() dto: CreateWallPostDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    if (dto.videoDurationSec && dto.videoDurationSec > 0) {
      const maxSec = await this.membershipGuard.getMaxVideoDurationSec(actorId);
      if (dto.videoDurationSec > maxSec) {
        await this.membershipGuard.requireTier(actorId, 'premium', 'video_duration');
      }
    }
    return this.wallService.createPost(actorId, dto);
  }

  // Called by user-service when a user's avatarUrl changes, to backfill
  // their existing posts/comments (see PROJECT_LOG.md, 2026-07-25).
  @Patch('internal/authors/:userId/avatar')
  async updateAuthorAvatar(
    @Param('userId') userId: string,
    @Body() body: { avatarUrl: string },
  ) {
    return this.wallService.updateAuthorAvatarEverywhere(userId, body.avatarUrl);
  }

  @Patch('posts/:id')
  async editPost(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Body() dto: EditWallPostDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.editPost(postId, actorId, dto);
  }

  @Get('posts')
  async listPosts(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('tag') tag?: string,
    @Query('sort') sort?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    const parsedOffset = offset ? parseInt(offset, 10) : 0;
    const actorId =
      authorization && authorization.startsWith('Bearer ')
        ? this.wallService.getActorIdFromAuth(authorization)
        : undefined;

    return this.wallService.listPosts(
      Number.isNaN(parsedLimit) ? 20 : parsedLimit,
      Number.isNaN(parsedOffset) ? 0 : parsedOffset,
      tag,
      sort,
      actorId,
    );
  }

  @Get('badges/catalog')
  getBadgeCatalog() {
    return this.wallService.getBadgeCatalog();
  }

  @Post('posts/views')
  async markPostsViewed(
    @Headers('authorization') authorization: string,
    @Body() dto: ViewPostsDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.markPostsViewed(
      actorId,
      dto.postIds || [],
      dto.dwellMsByPostId || {},
    );
  }

  @Post('posts/interactions')
  async trackInteraction(
    @Headers('authorization') authorization: string,
    @Body() dto: TrackWallInteractionDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.trackPostInteraction(actorId, dto);
  }

  @Post('posts/:id/reactions')
  async react(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Body() dto: ReactToPostDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    this.logger.log(
      `reactToPost request postId=${postId} actorId=${actorId} type=${dto?.type} imageIndex=${dto?.imageIndex}`,
    );
    return this.wallService.reactToPost(postId, actorId, dto);
  }

  @Post('posts/:id/comments')
  async comment(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Body() dto: AddCommentDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.addComment(postId, actorId, dto);
  }

  @Post('posts/:id/comments/:commentId/reactions')
  async reactToComment(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Param('commentId') commentId: string,
    @Body() dto: ReactToCommentDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    this.logger.log(
      `reactToComment request postId=${postId} commentId=${commentId} actorId=${actorId} type=${dto?.type}`,
    );
    return this.wallService.reactToComment(postId, commentId, actorId, dto);
  }

  @Delete('posts/:id/comments/:commentId')
  async deleteComment(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Param('commentId') commentId: string,
    @Body() dto: CommentActionDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.deleteComment(postId, commentId, actorId, dto);
  }

  @Post('posts/:id/comments/:commentId/report')
  async reportComment(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Param('commentId') commentId: string,
    @Body() dto: ReportCommentDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.reportComment(postId, commentId, actorId, dto);
  }

  @Post('posts/:id/report')
  async report(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Body() dto: ReportPostDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.reportPost(postId, actorId, dto);
  }

  @Post('posts/:id/share')
  async share(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
    @Body() dto: SharePostDto,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.sharePost(postId, actorId, dto);
  }

  @Delete('posts/:id')
  async remove(
    @Headers('authorization') authorization: string,
    @Param('id') postId: string,
  ) {
    const actorId = this.wallService.getActorIdFromAuth(authorization);
    return this.wallService.deletePost(postId, actorId);
  }
}
